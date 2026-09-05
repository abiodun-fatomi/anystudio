'use client';
/**
 * Publishing: the accounts posts go out through, and the posts themselves —
 * what is waiting to go out, grouped by day, and what already did.
 *
 * Connecting is a navigation to the API, which sends the browser to the
 * platform's consent screen and back here with ?connected= or ?error=.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, type PublishJob, type PublishPlatform, type SocialAccount, type SocialPlatform } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { PageHeader } from '@/components/shell/Page';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, SegmentedControl, Skeleton, Textarea, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import { FORMAT_WORDS, PLATFORM_WORDS } from '@/components/publishing/PublishDialog';
import styles from './publishing.module.css';

const CONNECT_ERRORS: Record<string, string> = {
  declined: 'You cancelled on the consent screen. Nothing was connected.',
  expired: 'That took too long — start the connection again.',
  state: 'We could not verify that came from the platform. Try again.',
  failed: 'The platform did not complete the connection. Try again in a moment.',
  no_account: 'Consent was given, but no account that can be posted to was found. Instagram needs a Professional account linked to a Facebook Page.',
  not_configured: 'Posting to that platform is not switched on in this environment yet.',
};

const PLATFORM_HELP: Record<SocialPlatform, string> = {
  INSTAGRAM: 'A Professional (Business or Creator) account linked to a Facebook Page. Feed posts, reels and stories.',
  TIKTOK: 'Any TikTok account. Videos. Until the app passes TikTok review, posts land as private to the account.',
};

function PlatformGlyph({ platform }: { platform: SocialPlatform }) {
  return platform === 'INSTAGRAM' ? (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M16.5 3c.3 2.3 1.7 3.9 4 4.1v3.2c-1.5 0-2.9-.5-4-1.3v6.4a5.6 5.6 0 1 1-5.6-5.6c.3 0 .6 0 .9.1v3.3a2.4 2.4 0 1 0 1.5 2.2V3h3.2Z" />
    </svg>
  );
}

const dayOf = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const STATUS_TONE: Record<PublishJob['status'], 'accent' | 'ok' | 'warn' | 'danger' | 'cyan' | undefined> = {
  SCHEDULED: 'accent',
  PUBLISHING: 'cyan',
  PUBLISHED: 'ok',
  FAILED: 'danger',
  CANCELLED: undefined,
};
const STATUS_WORDS: Record<PublishJob['status'], string> = {
  SCHEDULED: 'Scheduled',
  PUBLISHING: 'Posting…',
  PUBLISHED: 'Posted',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Publishing />
    </Suspense>
  );
}

function Publishing() {
  const { workspace } = useApp();
  const { toast } = useToast();
  const params = useSearchParams();
  const canManage = ['OWNER', 'ADMIN'].includes(workspace.role);

  const [platforms, setPlatforms] = useState<PublishPlatform[] | null>(null);
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [view, setView] = useState<'upcoming' | 'history'>((params.get('view') as 'history') === 'history' ? 'history' : 'upcoming');
  const [jobs, setJobs] = useState<PublishJob[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [disconnecting, setDisconnecting] = useState<SocialAccount | null>(null);
  const [cancelling, setCancelling] = useState<PublishJob | null>(null);
  const [editing, setEditing] = useState<PublishJob | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAccounts = useCallback(async () => {
    const [p, a] = await Promise.all([api.publishing.platforms(workspace.id).catch(() => []), api.publishing.accounts(workspace.id).catch(() => [])]);
    setPlatforms(Array.isArray(p) ? p : []);
    setAccounts(Array.isArray(a) ? a : []);
  }, [workspace.id]);
  const loadJobs = useCallback(
    async (after?: string) => {
      try {
        const r = await api.publishing.list(workspace.id, { view, cursor: after, take: 50 });
        setJobs((cur) => (after && cur ? [...cur, ...r.rows] : r.rows));
        setCursor(r.nextCursor);
      } catch {
        setJobs((cur) => cur ?? []);
      } finally {
        setMore(false);
      }
    },
    [workspace.id, view],
  );
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);
  useEffect(() => {
    setJobs(null);
    void loadJobs();
  }, [loadJobs]);

  // Back from the platform: say what happened, once, and clean the address bar.
  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    if (!connected && !error) return;
    if (connected)
      toast({
        title: `${PLATFORM_WORDS[connected.toUpperCase() as SocialPlatform] ?? 'Account'} connected`,
        body: 'Finished posts can go out from the library now.',
        tone: 'ok',
      });
    else
      toast({
        title: 'Not connected',
        body: CONNECT_ERRORS[error ?? ''] ?? 'Something went wrong on the way back.',
        tone: error === 'declined' ? 'warn' : 'danger',
      });
    window.history.replaceState(null, '', '/publishing');
  }, []);

  // Posting is quick; while something is in flight, keep the list honest.
  useEffect(() => {
    if (
      view !== 'upcoming' ||
      !jobs?.some((j) => j.status === 'PUBLISHING' || (j.status === 'SCHEDULED' && new Date(j.scheduledFor).getTime() < Date.now() + 60_000))
    )
      return;
    const t = setInterval(() => void loadJobs(), 10_000);
    return () => clearInterval(t);
  }, [view, jobs, loadJobs]);

  const grouped = useMemo(() => {
    const map = new Map<string, PublishJob[]>();
    for (const j of jobs ?? []) {
      const key = view === 'upcoming' ? dayOf(j.scheduledFor) : dayOf(j.publishedAt ?? j.updatedAt);
      map.set(key, [...(map.get(key) ?? []), j]);
    }
    return [...map.entries()];
  }, [jobs, view]);

  const disconnect = async () => {
    if (!disconnecting) return;
    setBusy(true);
    try {
      await api.publishing.disconnect(workspace.id, disconnecting.id);
      toast({ title: `${disconnecting.handle ? `@${disconnecting.handle}` : PLATFORM_WORDS[disconnecting.platform]} disconnected`, tone: 'ok' });
      setDisconnecting(null);
      await Promise.all([loadAccounts(), loadJobs()]);
    } catch (e) {
      toast({ title: 'Could not disconnect', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!cancelling) return;
    setBusy(true);
    try {
      await api.publishing.cancel(workspace.id, cancelling.id);
      setCancelling(null);
      await loadJobs();
    } catch (e) {
      toast({ title: 'Could not cancel', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const retry = async (j: PublishJob) => {
    try {
      await api.publishing.retry(workspace.id, j.id);
      toast({ title: 'Trying again now', tone: 'ok' });
      setView('upcoming');
    } catch (e) {
      toast({ title: 'Could not retry', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };

  const connectedCount = (accounts ?? []).filter((a) => a.status !== 'DISCONNECTED').length;

  return (
    <div className="rise">
      <PageHeader title="Publishing" lede="Post to Instagram and TikTok, or share to WhatsApp Status with the caption ready." />

      {/* ---- accounts ---- */}
      <section className={styles.section} aria-labelledby="accts">
        <div className={styles.sectionHead}>
          <div>
            <h2 id="accts">Accounts</h2>
            <p>Where posts can go. Connecting asks the platform for permission; nothing is posted until you say so.</p>
          </div>
        </div>
        <div className={styles.platforms}>
          {platforms === null || accounts === null
            ? [0, 1].map((i) => <Skeleton key={i} height={132} />)
            : platforms.map((p) => {
                const mine = accounts.filter((a) => a.platform === p.platform && a.status !== 'DISCONNECTED');
                return (
                  <article key={p.platform} className={styles.platform} data-platform={p.platform}>
                    <div className={styles.platformHead}>
                      <span className={styles.glyph}>
                        <PlatformGlyph platform={p.platform} />
                      </span>
                      <div>
                        <h3>{PLATFORM_WORDS[p.platform]}</h3>
                        <p>{PLATFORM_HELP[p.platform]}</p>
                      </div>
                    </div>
                    {mine.length > 0 && (
                      <ul className={styles.accountList}>
                        {mine.map((a) => (
                          <li key={a.id} className={styles.accountRow}>
                            {a.avatarUrl ? (
                              <img src={a.avatarUrl} alt="" />
                            ) : (
                              <span className={styles.avatarFallback}>{(a.handle ?? 'A').slice(0, 1).toUpperCase()}</span>
                            )}
                            <span className={styles.accountText}>
                              <span className={styles.handle}>{a.handle ? `@${a.handle}` : (a.displayName ?? 'Account')}</span>
                              <span className={styles.sub}>
                                {a.status === 'NEEDS_REAUTH' ? (
                                  <Badge tone="warn" dot>
                                    needs connecting again
                                  </Badge>
                                ) : (
                                  `Connected ${new Date(a.connectedAt).toLocaleDateString()}`
                                )}
                              </span>
                            </span>
                            {canManage && (
                              <span className={styles.rowActions}>
                                {a.status === 'NEEDS_REAUTH' && (
                                  <Button size="sm" href={api.publishing.connectUrl(workspace.id, a.platform)}>
                                    Reconnect
                                  </Button>
                                )}
                                <Button size="sm" variant="ghost" onClick={() => setDisconnecting(a)}>
                                  Disconnect
                                </Button>
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className={styles.platformFoot}>
                      {!p.available ? (
                        <span className={styles.unavailable}>Not switched on in this environment yet.</span>
                      ) : canManage ? (
                        <a className={styles.connect} href={api.publishing.connectUrl(workspace.id, p.platform)}>
                          <Icon.plus width={16} height={16} /> {mine.length ? 'Connect another' : `Connect ${PLATFORM_WORDS[p.platform]}`}
                        </a>
                      ) : (
                        <span className={styles.unavailable}>An owner or admin connects accounts.</span>
                      )}
                    </div>
                  </article>
                );
              })}
        </div>
      </section>

      {/* ---- posts ---- */}
      <section className={styles.section} aria-labelledby="posts">
        <div className={styles.sectionHead}>
          <div>
            <h2 id="posts">Posts</h2>
            <p>Every post is made from the library: open something you made and press Post.</p>
          </div>
          <SegmentedControl
            label="Show"
            value={view}
            onChange={setView}
            items={[
              { id: 'upcoming', label: 'Upcoming' },
              { id: 'history', label: 'History' },
            ]}
          />
        </div>

        {jobs === null ? (
          <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={72} />
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <EmptyState
            icon={<Icon.publish />}
            title={view === 'upcoming' ? 'Nothing scheduled' : 'Nothing posted yet'}
            body={
              connectedCount === 0
                ? 'Connect an account above, then open anything in your library and press Post.'
                : view === 'upcoming'
                  ? 'Open anything in your library and press Post — now, or pick a time.'
                  : 'Once something goes out, it shows here with a link to the post.'
            }
            actions={
              <Button href="/library" variant="ghost">
                Open the library
              </Button>
            }
          />
        ) : (
          <div className={styles.days}>
            {grouped.map(([day, rows]) => (
              <div key={day} className={styles.day}>
                <h3 className={styles.dayHead}>{day}</h3>
                <div className={styles.rows}>
                  {rows.map((j) => (
                    <article key={j.id} className={styles.job} data-status={j.status}>
                      <div className={styles.thumb}>
                        {j.mediaUrl ? (
                          j.mediaMime?.startsWith('video/') ? (
                            <video src={j.mediaUrl} muted playsInline preload="metadata" />
                          ) : (
                            <img src={j.mediaUrl} alt="" loading="lazy" />
                          )
                        ) : (
                          <span className={styles.thumbEmpty} />
                        )}
                      </div>
                      <div className={styles.jobText}>
                        <div className={styles.jobTop}>
                          <span className={styles.jobWho}>
                            <PlatformGlyph platform={j.platform} />
                            {j.account.handle ? `@${j.account.handle}` : PLATFORM_WORDS[j.platform]}
                          </span>
                          <span className={styles.jobFormat}>{FORMAT_WORDS[j.format]}</span>
                          <Badge tone={STATUS_TONE[j.status]} dot={j.status === 'PUBLISHING'}>
                            {STATUS_WORDS[j.status]}
                          </Badge>
                        </div>
                        <p className={styles.caption}>{j.caption || <em>No caption</em>}</p>
                        {j.status === 'FAILED' && j.failureReason && <p className={styles.reason}>{j.failureReason}</p>}
                      </div>
                      <div className={styles.jobSide}>
                        <span className={styles.when}>{view === 'upcoming' ? timeOf(j.scheduledFor) : timeOf(j.publishedAt ?? j.updatedAt)}</span>
                        <span className={styles.jobActions}>
                          {j.status === 'SCHEDULED' && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => setEditing(j)}>
                                Edit
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setCancelling(j)}>
                                Cancel
                              </Button>
                            </>
                          )}
                          {j.status === 'FAILED' && (
                            <Button size="sm" variant="subtle" onClick={() => void retry(j)}>
                              Try again
                            </Button>
                          )}
                          {j.status === 'PUBLISHED' && j.externalUrl && (
                            <a className={styles.open} href={j.externalUrl} target="_blank" rel="noreferrer">
                              Open post
                            </a>
                          )}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ))}
            {cursor && (
              <div style={{ paddingTop: 'var(--s-2)' }}>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={more}
                  onClick={() => {
                    setMore(true);
                    void loadJobs(cursor);
                  }}
                >
                  Show more
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={disconnecting !== null}
        onClose={() => setDisconnecting(null)}
        onConfirm={() => void disconnect()}
        busy={busy}
        title={`Disconnect ${disconnecting?.handle ? `@${disconnecting.handle}` : 'this account'}?`}
        description="Anything scheduled through it is cancelled. Nothing already posted is touched. You can connect it again any time."
        confirmLabel="Disconnect"
        danger
      />
      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        onConfirm={() => void cancel()}
        busy={busy}
        title="Cancel this post?"
        description="It will not go out. The picture stays in your library."
        confirmLabel="Cancel the post"
        danger
      />
      {editing && (
        <EditJob
          job={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await loadJobs();
          }}
        />
      )}
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EditJob({ job, onClose, onSaved }: { job: PublishJob; onClose: () => void; onSaved: () => Promise<void> }) {
  const { workspace } = useApp();
  const { toast } = useToast();
  const [caption, setCaption] = useState(job.caption);
  const [at, setAt] = useState(toLocalInput(job.scheduledFor));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.publishing.patch(workspace.id, job.id, { caption, scheduledFor: new Date(at).toISOString() });
      await onSaved();
    } catch (e) {
      toast({ title: 'Could not save', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title="Change the post"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep as is
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={() => void save()} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
        <Textarea label="Caption" value={caption} onChange={(e) => setCaption(e.target.value)} rows={5} maxLength={2200} hint={`${caption.length} / 2200`} />
        <label className="field">
          <span>Post at</span>
          <input className="inp" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}
