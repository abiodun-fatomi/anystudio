'use client';
/**
 * Post… — the one place a finished picture or reel leaves for the world.
 *
 * Two tabs. "Post" goes through a connected Instagram or TikTok account,
 * now or at a chosen time; one job per account, each with its own retry and
 * its own line on the Publishing page. "Share" needs no account at all: a
 * one-hour link to the file, the caption on the clipboard, and on a phone
 * the native share sheet with the file attached — which is how a WhatsApp
 * Status gets posted, since WhatsApp offers no API for that.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, type LibraryOutput, type PublishFormat, type SocialAccount, type SocialPlatform } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Badge, Button, Dialog, SegmentedControl, Select, Skeleton, Textarea, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './PublishDialog.module.css';

export const PLATFORM_WORDS: Record<SocialPlatform, string> = { INSTAGRAM: 'Instagram', TIKTOK: 'TikTok' };
export const FORMAT_WORDS: Record<PublishFormat, string> = { IMAGE: 'Feed post', VIDEO: 'Video', REEL: 'Reel', STORY: 'Story' };

/** A caption from whatever copy came back with the item: a string, or an object with caption/hashtags/… */
export function captionFrom(text: unknown, title?: string | null): string {
  if (typeof text === 'string') return text.trim();
  if (text && typeof text === 'object') {
    const t = text as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of ['caption', 'headline', 'description', 'body', 'text']) if (typeof t[k] === 'string') parts.push((t[k] as string).trim());
    const tags = t.hashtags;
    if (Array.isArray(tags)) parts.push(tags.map((h) => (String(h).startsWith('#') ? String(h) : `#${h}`)).join(' '));
    else if (typeof tags === 'string') parts.push(tags);
    if (parts.length) return parts.filter(Boolean).join('\n\n');
    const first = Object.values(t).find((v) => typeof v === 'string');
    if (typeof first === 'string') return first.trim();
  }
  return title ?? '';
}

/** Local datetime-local value for "in ten minutes", rounded up to the next five. */
function defaultWhen(): string {
  const d = new Date(Date.now() + 10 * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface PublishTarget {
  /** Where the media came from, for the library's "posted" trail. */
  generationId?: string;
  title?: string | null;
  /** Whatever copy came back, for the caption. */
  text?: unknown;
  /** Postable files: images and videos, with a signed URL to preview. */
  outputs: LibraryOutput[];
}

export function PublishDialog({ open, onClose, target }: { open: boolean; onClose: () => void; target: PublishTarget | null }) {
  const { workspace } = useApp();
  const { toast } = useToast();
  const [tab, setTab] = useState<'post' | 'share'>('post');
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [mediaKey, setMediaKey] = useState<string>('');
  const [format, setFormat] = useState<PublishFormat>('IMAGE');
  const [caption, setCaption] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(defaultWhen());
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<{ url: string; mime: string | null } | null>(null);

  const files = useMemo(
    () => (target?.outputs ?? []).filter((o) => o.key && !o.locked && (o.mime.startsWith('image/') || o.mime.startsWith('video/'))),
    [target],
  );
  const file = files.find((f) => f.key === mediaKey) ?? files[0] ?? null;
  const isVideo = Boolean(file?.mime.startsWith('video/'));

  // Fresh state each time it opens for a different item.
  useEffect(() => {
    if (!open || !target) return;
    setTab('post');
    setMediaKey(files[0]?.key ?? '');
    setCaption(captionFrom(target.text, target.title));
    setWhen('now');
    setAt(defaultWhen());
    setShare(null);
    setChosen(new Set());
    let live = true;
    api.publishing
      .accounts(workspace.id)
      .then((a) => {
        if (!live) return;
        setAccounts(a);
        const connected = a.filter((x) => x.status === 'CONNECTED');
        if (connected.length === 1) setChosen(new Set([connected[0]!.id]));
      })
      .catch(() => live && setAccounts([]));
    return () => {
      live = false;
    };
  }, [open, target?.generationId]);

  // The format follows the file and the platforms chosen.
  const chosenPlatforms = useMemo(() => new Set((accounts ?? []).filter((a) => chosen.has(a.id)).map((a) => a.platform)), [accounts, chosen]);
  const formatOptions = useMemo<PublishFormat[]>(() => {
    const opts: PublishFormat[] = isVideo ? ['REEL', 'STORY', 'VIDEO'] : ['IMAGE', 'STORY'];
    // Only formats every chosen platform takes; with none chosen, everything the file allows.
    return opts.filter((f) => [...chosenPlatforms].every((p) => (p === 'INSTAGRAM' ? ['IMAGE', 'REEL', 'STORY'] : ['VIDEO']).includes(f)));
  }, [isVideo, chosenPlatforms]);
  useEffect(() => {
    if (!formatOptions.includes(format)) setFormat(formatOptions[0] ?? (isVideo ? 'REEL' : 'IMAGE'));
  }, [formatOptions, format, isVideo]);

  const toggle = (id: string) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const submit = async () => {
    if (!file || chosen.size === 0) return;
    setBusy(true);
    try {
      const jobs = await api.publishing.create(workspace.id, {
        accountIds: [...chosen],
        generationId: target?.generationId,
        mediaKey: file.key,
        format,
        caption,
        scheduledFor: when === 'later' ? new Date(at).toISOString() : undefined,
      });
      toast({
        title:
          when === 'later'
            ? `Scheduled ${jobs.length === 1 ? 'the post' : `${jobs.length} posts`}`
            : `Posting now to ${jobs.length === 1 ? PLATFORM_WORDS[jobs[0]!.platform] : `${jobs.length} accounts`}`,
        body: 'Progress and the result are on the Publishing page; the bell will tell you when it lands.',
        tone: 'ok',
      });
      onClose();
    } catch (e) {
      toast({ title: 'Could not create the post', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const loadShare = useCallback(async () => {
    if (!file || share) return;
    try {
      const s = await api.publishing.share(workspace.id, file.key);
      setShare({ url: s.url, mime: s.mime });
    } catch (e) {
      toast({ title: 'Could not make a share link', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  }, [file, share, workspace.id, toast]);
  useEffect(() => {
    if (tab === 'share') void loadShare();
  }, [tab, loadShare]);

  const copyCaption = async () => {
    try {
      await navigator.clipboard.writeText(caption);
      toast({ title: 'Caption copied', tone: 'ok' });
    } catch {
      toast({ title: 'Could not copy — select the text and copy it yourself', tone: 'warn' });
    }
  };

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const nativeShare = async () => {
    if (!share || !file) return;
    try {
      const blob = await fetch(share.url).then((r) => r.blob());
      const ext = (share.mime ?? file.mime).split('/')[1] ?? 'bin';
      const f = new File([blob], `${(target?.title ?? 'anystudio').replace(/[^\w-]+/g, '-').slice(0, 40) || 'anystudio'}.${ext}`, {
        type: share.mime ?? file.mime,
      });
      const data: ShareData = { files: [f], text: caption };
      if (navigator.canShare && !navigator.canShare(data)) {
        await navigator.share({ text: caption, url: share.url });
      } else await navigator.share(data);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      toast({ title: 'Sharing did not work here', body: 'Download the file and post it from the app instead.', tone: 'warn' });
    }
  };

  const connected = (accounts ?? []).filter((a) => a.status === 'CONNECTED');
  const needsReauth = (accounts ?? []).filter((a) => a.status === 'NEEDS_REAUTH');

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="Post it"
      wide
      footer={
        tab === 'post' ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Not now
            </Button>
            <span style={{ flex: 1 }} />
            <Button onClick={() => void submit()} loading={busy} disabled={!file || chosen.size === 0 || caption.length > 2200}>
              {when === 'later' ? 'Schedule' : `Post now${chosen.size > 1 ? ` · ${chosen.size}` : ''}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
            <span style={{ flex: 1 }} />
            {canNativeShare && (
              <Button onClick={() => void nativeShare()} disabled={!share}>
                Share…
              </Button>
            )}
          </>
        )
      }
    >
      {!target ? null : (
        <div className={styles.root}>
          <div className={styles.preview}>
            {file ? (
              isVideo ? (
                <video src={file.url ?? undefined} controls muted playsInline preload="metadata" />
              ) : (
                <img src={file.url ?? undefined} alt="" />
              )
            ) : (
              <div className={styles.noFile}>Nothing here can be posted — copy and audio go with a picture.</div>
            )}
            {files.length > 1 && (
              <Select
                label="Which file"
                value={file?.key ?? ''}
                onChange={(e) => setMediaKey(e.target.value)}
                options={files.map((f) => ({ value: f.key, label: `${f.size ?? f.role}${f.width && f.height ? ` · ${f.width}×${f.height}` : ''}` }))}
              />
            )}
          </div>

          <div className={styles.form}>
            <SegmentedControl
              label="How"
              value={tab}
              onChange={setTab}
              items={[
                { id: 'post', label: 'Post to an account' },
                { id: 'share', label: 'Share / WhatsApp Status' },
              ]}
            />

            {tab === 'post' ? (
              <>
                <div className={styles.section}>
                  <div className={styles.sectionHead}>
                    <strong>Accounts</strong>
                    <Link href="/publishing" className={styles.manage}>
                      Manage
                    </Link>
                  </div>
                  {accounts === null ? (
                    <Skeleton height={44} />
                  ) : connected.length === 0 ? (
                    <div className={styles.empty}>
                      {needsReauth.length > 0 ? 'Your account needs connecting again.' : 'No account connected yet.'}{' '}
                      <Link href="/publishing">Connect Instagram or TikTok</Link> — or use Share to post it by hand.
                    </div>
                  ) : (
                    <div className={styles.accounts}>
                      {connected.map((a) => {
                        const fits = isVideo ? a.platform === 'INSTAGRAM' || a.platform === 'TIKTOK' : a.platform === 'INSTAGRAM';
                        return (
                          <button
                            key={a.id}
                            type="button"
                            className={styles.account}
                            aria-pressed={chosen.has(a.id)}
                            disabled={!fits}
                            title={fits ? undefined : 'TikTok takes videos from here for now'}
                            onClick={() => toggle(a.id)}
                          >
                            {a.avatarUrl ? (
                              <img src={a.avatarUrl} alt="" />
                            ) : (
                              <span className={styles.avatarFallback}>{(a.handle ?? a.platform).slice(0, 1).toUpperCase()}</span>
                            )}
                            <span className={styles.accountText}>
                              <span className={styles.handle}>{a.handle ? `@${a.handle}` : (a.displayName ?? PLATFORM_WORDS[a.platform])}</span>
                              <span className={styles.platform}>{PLATFORM_WORDS[a.platform]}</span>
                            </span>
                            <span className={styles.tick} aria-hidden="true">
                              <Icon.check width={14} height={14} />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {formatOptions.length > 1 && (
                  <SegmentedControl label="As" value={format} onChange={setFormat} items={formatOptions.map((f) => ({ id: f, label: FORMAT_WORDS[f] }))} />
                )}

                <Textarea
                  label="Caption"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  rows={5}
                  maxLength={2200}
                  hint={`${caption.length} / 2200${format === 'STORY' ? ' · stories show no caption on Instagram' : ''}`}
                />

                <div className={styles.section}>
                  <SegmentedControl
                    label="When"
                    value={when}
                    onChange={setWhen}
                    items={[
                      { id: 'now', label: 'Now' },
                      { id: 'later', label: 'Pick a time' },
                    ]}
                  />
                  {when === 'later' && (
                    <input
                      className="inp"
                      type="datetime-local"
                      value={at}
                      min={defaultWhen()}
                      onChange={(e) => setAt(e.target.value)}
                      aria-label="Post at"
                      style={{ marginTop: 'var(--s-2)' }}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className={styles.share}>
                <p className={styles.lede}>
                  WhatsApp has no way for an app to post a Status for you, so this is the two-tap version: the file and the caption, ready for the app.
                </p>
                <ol className={styles.steps}>
                  <li>
                    <span>Copy the caption</span>
                    <Button size="sm" variant="subtle" onClick={() => void copyCaption()}>
                      Copy caption
                    </Button>
                  </li>
                  <li>
                    <span>{canNativeShare ? 'Share the file straight into WhatsApp' : 'Download the file'}</span>
                    {canNativeShare ? (
                      <Button size="sm" onClick={() => void nativeShare()} disabled={!share}>
                        Share…
                      </Button>
                    ) : share ? (
                      <a className={styles.download} href={share.url} download target="_blank" rel="noreferrer">
                        Download
                      </a>
                    ) : (
                      <Skeleton height={32} style={{ width: 100 }} />
                    )}
                  </li>
                  <li>
                    <span>In WhatsApp: Status → add, pick the file, paste the caption.</span>
                  </li>
                </ol>
                <Textarea label="Caption" value={caption} onChange={(e) => setCaption(e.target.value)} rows={4} />
                <p className={styles.fine}>
                  <Badge tone="accent">1 hour</Badge> The file link works for an hour; open this again for a fresh one.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
