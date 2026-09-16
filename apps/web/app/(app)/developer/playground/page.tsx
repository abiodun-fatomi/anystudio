'use client';
/**
 * The playground: run the API on a photo without writing a line of code.
 *
 * The menu comes from the API — each feature a capability with its
 * parameters decided server-side and priced from the live credit table —
 * so what is shown is what an integration would pay. Compose the request
 * on the left, hand it a photo on the right (drop, choose, paste, or a
 * link), and each pick becomes a real generation: charged to the
 * workspace's credits, streamed as it runs over the seller's own photo,
 * then shown as a card that opens at full size beside the original, downloads
 * as the files an integration would get, and carries the exact request that
 * made it. Every run is real provider spend, so the workspace has a daily
 * allowance on top of its credits; the page shows it and stops at it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import {
  api,
  ApiError,
  type DevKey,
  type GenerationRow,
  type MediaAssetRow,
  type PlaygroundAllowance,
  type PlaygroundFeature,
  type PlaygroundFeatureKey,
} from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { uploadFile } from '@/lib/upload';
import { Button, Input, Skeleton, Textarea } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import { Lightbox, type Shot } from '../../studio/Lightbox';
import dev from '../developer.module.css';
import styles from './playground.module.css';

interface Run {
  feature: PlaygroundFeatureKey;
  capability: string;
  row: GenerationRow | null;
  stage: string;
  progress: number;
  urls: Record<string, string>;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface Verdict {
  verdict: string;
  confidence: number;
  saw: string;
  issues: string[];
  advice: string;
}

interface Copy {
  description?: { long?: string; short?: string; bullets?: string[]; specs?: Array<{ label: string; value: string }> };
  seo?: { title?: string };
}

const ISSUE_WORDS: Record<string, string> = {
  screenshot: 'a screenshot',
  document_or_text: 'a document or text',
  person_is_subject: 'a person as the subject',
  no_product_visible: 'no product visible',
  multiple_products: 'several products',
  blurry: 'blurred',
  too_dark: 'too dark',
  watermark_or_overlay: 'a watermark or overlay',
  category_mismatch: 'not the declared category',
  name_mismatch: 'not the declared name',
  low_resolution: 'low resolution',
};

/** The menu, in the order a buyer reads it: what it looks like, what it says, what moves. */
const SECTIONS: Array<{ kind: PlaygroundFeature['kind']; title: string; note: string }> = [
  { kind: 'image', title: 'Pictures', note: 'from the one photo' },
  { kind: 'text', title: 'Words', note: 'read from the photo' },
  { kind: 'video', title: 'Video', note: 'what a reel or an ad costs' },
];

const DEFAULT_PICK: PlaygroundFeatureKey[] = ['check', 'background', 'copy'];

const resetWords = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  const h = Math.max(0, Math.floor(ms / 3_600_000));
  const m = Math.max(0, Math.floor((ms % 3_600_000) / 60_000));
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
};

const looksLikeImageUrl = (s: string) => /^https?:\/\/\S+\.(jpe?g|png|webp|gif|avif)(\?\S*)?$/i.test(s.trim());

const seconds = (from: number, to: number) => `${Math.max(0, Math.round((to - from) / 1000))}s`;

/** The request as an integration would send it, with the workspace's own key prefix standing in for the secret. */
function curlFor(capability: string, params: unknown, prefix: string | null, clientKey: string): string {
  const body = { capability, params, clientKey };
  return [
    `curl -X POST https://api.anystudio.ai/api/v1/generations \\`,
    `  -H "Authorization: Bearer ${prefix ? `${prefix}…` : 'as_test_…'}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(body, null, 2).replace(/\n/g, '\n      ')}'`,
  ].join('\n');
}

const STAGE_WORDS: Record<string, string> = {
  queued: 'Waiting for a worker',
  preparing: 'Reading your photo',
  generating: 'Making it',
  composing: 'Finishing',
  done: 'Done',
  failed: 'Could not make it',
};

type State = 'queued' | 'running' | 'done' | 'failed';
const stateOf = (r: Run): State => (r.error || r.row?.status === 'FAILED' ? 'failed' : r.row?.status === 'SUCCEEDED' ? 'done' : r.row ? 'running' : 'queued');

export default function PlaygroundPage() {
  const { workspace, balance, refreshBalance } = useApp();
  const workspaceId = workspace.id;
  const [allowance, setAllowance] = useState<PlaygroundAllowance | null>(null);
  const [features, setFeatures] = useState<PlaygroundFeature[] | null>(null);
  const [keyPrefix, setKeyPrefix] = useState<string | null>(null);
  const [picked, setPicked] = useState<PlaygroundFeatureKey[]>(DEFAULT_PICK);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [url, setUrl] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<{ asset: MediaAssetRow; url: string | null; title: string | null } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [showWire, setShowWire] = useState(false);
  const [wireFor, setWireFor] = useState<PlaygroundFeatureKey | null>(null);
  const [view, setView] = useState<{ shots: Shot[]; at: number } | null>(null);
  const [copied, setCopied] = useState<PlaygroundFeatureKey | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const streams = useRef<EventSource[]>([]);
  const bench = useRef<HTMLDivElement>(null);

  useEffect(() => () => streams.current.forEach((s) => s.close()), []);

  /**
   * Where the workbench starts, so the columns can be sized to what is left
   * of the screen below it and the page itself never has to move: the
   * Developer header and its tabs stay put, the menu scrolls inside its own
   * frame, the photo stays where it is. Measured, because the header above
   * wraps differently at every width.
   */
  useLayoutEffect(() => {
    const el = bench.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.setProperty('--bench-top', `${Math.max(0, Math.round(top))}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [source]);

  // A clock, only while something is running: the cards say how long each took.
  const live = runs.some((r) => stateOf(r) === 'queued' || stateOf(r) === 'running');
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const loadMenu = useCallback(async () => {
    try {
      const { features: menu, ...a } = await api.developer.playground(workspaceId);
      setAllowance(a);
      setFeatures(menu);
    } catch {
      setFeatures([]);
    }
  }, [workspaceId]);
  useEffect(() => {
    void loadMenu();
    api.developer
      .keys(workspaceId)
      .then((ks: DevKey[]) => setKeyPrefix(ks.find((k) => !k.revokedAt)?.prefix ?? null))
      .catch(() => setKeyPrefix(null));
  }, [workspaceId, loadMenu]);

  const patch = (key: PlaygroundFeatureKey, fn: (r: Run) => Run) => setRuns((rs) => rs.map((r) => (r.feature === key ? fn(r) : r)));

  async function finish(key: PlaygroundFeatureKey, id: string) {
    try {
      const { generation, message } = await api.generations.get(workspaceId, id);
      const keys = (generation.outputs ?? []).map((o) => o.key).filter(Boolean);
      const urls = keys.length ? (await api.media.urls(workspaceId, keys)).urls : {};
      // A failed row comes with the API's own sentence — what happened and that the credits are back.
      const failed = generation.status === 'FAILED';
      patch(key, (r) => ({
        ...r,
        row: generation,
        urls,
        stage: failed ? 'failed' : 'done',
        progress: 100,
        error: failed ? (message ?? r.error) : r.error,
        finishedAt: Date.now(),
      }));
      void refreshBalance();
    } catch (e) {
      patch(key, (r) => ({ ...r, error: e instanceof ApiError ? e.message : 'Could not read the result.', finishedAt: Date.now() }));
    }
  }

  function watch(key: PlaygroundFeatureKey, id: string) {
    const es = new EventSource(api.generations.streamUrl(workspaceId, id));
    streams.current.push(es);
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as { type: string; stage?: string; progress?: number; detail?: string };
        if (e.type === 'stage') patch(key, (r) => ({ ...r, stage: e.detail ?? e.stage ?? r.stage, progress: e.progress ?? r.progress }));
        if (e.type === 'done') {
          es.close();
          void finish(key, id);
        }
      } catch {
        /* a malformed event is not worth a broken card */
      }
    };
    es.onerror = () => {
      es.close();
      void finish(key, id);
    };
  }

  /** Start these features on this photo. New cards are added; a card asked again is reset in place. */
  async function start(asset: MediaAssetRow, keys: PlaygroundFeatureKey[], name: string | null) {
    const menu = features ?? [];
    const fresh = keys.map<Run>((feature) => ({
      feature,
      capability: menu.find((f) => f.key === feature)?.capability ?? '',
      row: null,
      stage: 'queued',
      progress: 0,
      urls: {},
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    }));
    setRuns((rs) => [...rs.filter((r) => !keys.includes(r.feature)), ...fresh]);
    try {
      const out = await api.developer.playgroundRun(workspaceId, {
        assetId: asset.id,
        features: keys,
        ...(name ? { title: name } : {}),
        ...(details.trim() ? { details: details.trim() } : {}),
      });
      setAllowance(out.allowance);
      void refreshBalance();
      for (const r of out.runs) {
        patch(r.feature, (cur) => ({ ...cur, row: r.generation, capability: r.capability, stage: r.generation.stage ?? 'queued' }));
        if (r.generation.status === 'SUCCEEDED' || r.generation.status === 'FAILED') void finish(r.feature, r.generation.id);
        else watch(r.feature, r.generation.id);
      }
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Could not start it.';
      setRuns((rs) => rs.map((r) => (keys.includes(r.feature) ? { ...r, error: message, finishedAt: Date.now() } : r)));
      if (e instanceof ApiError && e.code === 'playground_exhausted') void loadMenu();
    }
  }

  async function run(asset: MediaAssetRow, pageTitle: string | null) {
    const srcUrl = (await api.media.urls(workspaceId, [asset.key])).urls[asset.key] ?? null;
    const name = title.trim() || pageTitle;
    setSource({ asset, url: srcUrl, title: name });
    const menu = features ?? [];
    await start(
      asset,
      menu.filter((f) => picked.includes(f.key)).map((f) => f.key),
      name,
    );
  }

  async function fromFile(file: File) {
    setError(null);
    setBusy('Uploading your photo…');
    try {
      const asset = await uploadFile(workspaceId, file);
      await run(asset, null);
    } catch (e) {
      // uploadFile already turns the API's reasons into plain Errors; the words are the useful part.
      setError(e instanceof Error && e.message ? e.message : 'Could not upload that photo.');
    } finally {
      setBusy(null);
    }
  }

  async function fromLink(link = url) {
    if (!link.trim()) return;
    setError(null);
    setBusy(looksLikeImageUrl(link) ? 'Fetching the picture…' : 'Reading the page and fetching its picture…');
    try {
      const got = await api.media.fromUrl(workspaceId, link.trim());
      await run(got.asset, got.title);
    } catch (e) {
      setError(e instanceof ApiError ? (e.fields?.find((f) => f.path === 'url')?.message ?? e.message) : 'Could not read that link.');
    } finally {
      setBusy(null);
    }
  }

  const reset = () => {
    streams.current.forEach((s) => s.close());
    streams.current = [];
    setSource(null);
    setRuns([]);
    setUrl('');
    setError(null);
    setShowWire(false);
    setWireFor(null);
  };

  const menu = features ?? [];
  const chosen = menu.filter((f) => picked.includes(f.key));
  const cost = chosen.reduce((n, f) => n + f.credits, 0);
  const short = balance !== null && cost > balance;
  const exhausted = allowance !== null && allowance.remaining < picked.length;
  const canRun = picked.length > 0 && !busy && !exhausted && !short;
  const spent = runs.reduce((n, r) => n + (r.row?.status === 'SUCCEEDED' ? r.row.credits : 0), 0);
  const featureOf = (r: Run) => menu.find((f) => f.key === r.feature);
  const clientKeyOf = (r: Run) => `playground:${source?.asset.id.slice(0, 8) ?? ''}:${r.feature}:v1`;
  const notYet = useMemo(() => menu.filter((f) => !runs.some((r) => r.feature === f.key)), [menu, runs]);
  const canAdd = (f: PlaygroundFeature) => (allowance?.remaining ?? 0) >= 1 && (balance === null || f.credits <= balance);

  /** Every picture a run produced, the original first, so the arrows compare. */
  const shotsOf = (r: Run): Shot[] => {
    const f = featureOf(r);
    const list: Shot[] = [];
    if (source?.url) list.push({ src: source.url, alt: 'Your photo, as uploaded' });
    for (const o of r.row?.outputs ?? []) {
      const u = o.key ? r.urls[o.key] : undefined;
      if (!u || (o.role !== 'image' && o.role !== 'variant')) continue;
      list.push({
        src: u,
        alt: o.role === 'image' ? `${f?.label ?? r.feature} — full size` : `${f?.label ?? r.feature} — ${o.size ?? 'crop'}`,
        meta: o.width ? `${o.width}×${o.height}` : undefined,
      });
    }
    return list;
  };

  const copyText = async (r: Run, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(r.feature);
      setTimeout(() => setCopied((c) => (c === r.feature ? null : c)), 1600);
    } catch {
      /* the clipboard can be refused; the words are still on the page */
    }
  };

  /** Ctrl/Cmd+V anywhere on the page: a copied image runs as an upload, a copied link as a link. */
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!canRun || source) return;
    const file = [...(e.clipboardData.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void fromFile(file);
      return;
    }
    const text = e.clipboardData.getData('text/plain').trim();
    const inLinkBox = (e.target as HTMLElement | null)?.getAttribute?.('aria-label') === 'Listing link';
    if (/^https?:\/\//i.test(text) && !inLinkBox) {
      e.preventDefault();
      setUrl(text);
      void fromLink(text);
    }
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && canRun) void fromFile(f);
  };

  const stateWords = (r: Run) => {
    if (r.error) return r.error;
    if (r.row?.status === 'FAILED') return 'Could not make it — credits returned';
    return STAGE_WORDS[r.stage] ?? r.stage;
  };

  const took = (r: Run) => seconds(r.startedAt, r.finishedAt ?? now);

  const wireBlock = (r: Run) => (
    <div className={styles.wire}>
      <div className={styles.wireHead}>
        {featureOf(r)?.label ?? r.feature} <code>{clientKeyOf(r)}</code>
      </div>
      <pre className={dev.code}>{curlFor(r.capability, r.row?.input ?? { sourceKey: source?.asset.key }, keyPrefix, clientKeyOf(r))}</pre>
      {r.row && (
        <pre className={dev.code}>
          {JSON.stringify(
            { id: r.row.id, status: r.row.status, capability: r.row.capability, credits: r.row.credits, outputs: r.row.outputs ?? null },
            null,
            2,
          )}
        </pre>
      )}
    </div>
  );

  /** The footer every result card shares: what it cost and took, and what can be done with it. */
  const foot = (r: Run, extra?: React.ReactNode) => {
    const st = stateOf(r);
    return (
      <div className={styles.cardFoot}>
        <span>
          {r.row?.credits ?? featureOf(r)?.credits ?? 0} cr · {took(r)}
        </span>
        <div className={styles.actions}>
          {extra}
          {st === 'done' && r.row && (
            <a className={styles.action} href={api.library.downloadUrl(workspaceId, r.row.id)} title="Every file this made, zipped">
              <Icon.external /> Download
            </a>
          )}
          {st === 'failed' && source && (
            <button type="button" className={styles.action} onClick={() => void start(source.asset, [r.feature], source.title)}>
              Run again
            </button>
          )}
          <button
            type="button"
            className={styles.action}
            aria-pressed={wireFor === r.feature}
            onClick={() => setWireFor((w) => (w === r.feature ? null : r.feature))}
            title="The request your code would send"
          >
            <Icon.code /> Request
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={dev.group} onPaste={onPaste} data-wide="">
      <div className={styles.head}>
        <div>
          <div className={dev.groupTitle}>Playground</div>
          <p className={dev.groupLede}>
            The API on one of your photos, without writing code. Every call here is a real one: priced as your integration would be charged, queued and streamed
            the same way, and shown with the request that made it.
          </p>
        </div>
        <div className={styles.allowance} aria-live="polite">
          {allowance ? (
            <>
              <span
                className={styles.ring}
                data-empty={allowance.remaining === 0}
                style={{ ['--p' as string]: Math.round((allowance.usedToday / allowance.dailyLimit) * 100) }}
                aria-hidden="true"
              />
              <span>
                <strong>
                  {allowance.remaining} of {allowance.dailyLimit}
                </strong>
                playground calls left today
                {allowance.remaining === 0 ? ` · resets ${resetWords(allowance.resetsAt)}` : ''}
                <br />
                Your API keys are not limited this way.
              </span>
            </>
          ) : (
            <Skeleton width={220} height={34} />
          )}
        </div>
      </div>

      {!source && (
        <div className={styles.bench} ref={bench}>
          <section className={styles.menu} role="group" aria-label="What to run">
            <div className={styles.menuHead}>
              <h3>What to run</h3>
              <span>
                {picked.length} picked · {cost.toLocaleString()} cr
              </span>
            </div>
            {features === null ? (
              <Skeleton height={320} />
            ) : (
              SECTIONS.map((s) => {
                const items = menu.filter((f) => f.kind === s.kind);
                if (items.length === 0) return null;
                return (
                  <div key={s.kind} className={styles.section}>
                    <div className={styles.sectionTitle}>
                      {s.title} <span>{s.note}</span>
                    </div>
                    {items.map((f) => {
                      const on = picked.includes(f.key);
                      return (
                        <button
                          key={f.key}
                          type="button"
                          className={styles.opt}
                          aria-pressed={on}
                          data-kind={f.kind}
                          onClick={() => setPicked((p) => (on ? p.filter((x) => x !== f.key) : [...p, f.key]))}
                        >
                          <span className={styles.tick} aria-hidden="true">
                            <Icon.check width={12} height={12} />
                          </span>
                          <div>
                            <strong>{f.label}</strong>
                            <span>{f.help}</span>
                          </div>
                          <code className={styles.cost}>{f.credits.toLocaleString()} cr</code>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
            <div className={styles.tally}>
              <div>
                <strong>{cost.toLocaleString()}</strong> <span>credits{balance !== null ? ` of your ${balance.toLocaleString()}` : ''}</span>
              </div>
              <span>{picked.length === 0 ? 'Pick at least one thing' : `${picked.length} call${picked.length === 1 ? '' : 's'}, one photo`}</span>
            </div>
          </section>

          <section className={styles.stage}>
            <label
              className={styles.drop}
              data-over={over}
              aria-disabled={!canRun}
              onDragOver={(e) => {
                e.preventDefault();
                if (canRun) setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
            >
              <span className={styles.dropIcon} aria-hidden="true">
                <Icon.studio width={26} height={26} />
              </span>
              <strong>{picked.length === 0 ? 'Pick something to run first' : busy ? busy : 'Drop a product photo here'}</strong>
              <span>
                or tap to choose one · paste a copied image with <kbd>⌘V</kbd> · JPEG, PNG or WebP
              </span>
              <input type="file" accept="image/*" disabled={!canRun} onChange={(e) => e.target.files?.[0] && void fromFile(e.target.files[0])} />
            </label>
            <div className={styles.linkRow}>
              <Input
                className={styles.inp}
                placeholder="Or paste a listing link — the page is read and its photo fetched"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canRun && void fromLink()}
                aria-label="Listing link"
                disabled={!canRun}
              />
              <Button onClick={() => void fromLink()} disabled={!url.trim() || !canRun}>
                Fetch it
              </Button>
            </div>
            <div className={styles.about}>
              <div className={styles.aboutTitle}>About the product</div>
              <Input
                label="Product name"
                optional
                placeholder="iPhone 17 Pro, 256 GB, blue"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
              />
              <Textarea
                label="Details the photo cannot show"
                optional
                placeholder="Storage, condition, what is in the box, price… The copy uses exactly this and invents nothing."
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                maxLength={800}
                rows={2}
              />
            </div>
            {error && (
              <div className={styles.note} data-tone="warn">
                {error}
              </div>
            )}
            {short && balance !== null && (
              <div className={styles.note} data-tone="warn">
                That is {cost.toLocaleString()} credits and this workspace has {balance.toLocaleString()}. Take something off, or top up under Credits.
              </div>
            )}
            {exhausted && allowance && !short && (
              <div className={styles.note} data-tone="warn">
                {allowance.remaining === 0
                  ? `Today's ${allowance.dailyLimit} playground calls are used. It resets ${resetWords(allowance.resetsAt)}; an API key can keep going now.`
                  : `${allowance.remaining} call${allowance.remaining === 1 ? '' : 's'} left today — pick ${allowance.remaining} or fewer, or wait for the reset ${resetWords(allowance.resetsAt)}.`}
              </div>
            )}
          </section>
        </div>
      )}

      {source && (
        <div className={styles.session} ref={bench}>
          <div className={styles.sessionBar}>
            {source.url ? <img className={styles.thumb} src={source.url} alt="" /> : <span className={styles.thumb} />}
            <div style={{ minWidth: 0 }}>
              <strong>{source.title ?? 'Your photo'}</strong>
              <small>
                {runs.length} call{runs.length === 1 ? '' : 's'} · {spent.toLocaleString()} credit{spent === 1 ? '' : 's'} spent
                {live ? ' · running' : ''}
                {source.title ? ' · the name the check compares against and the copy is written for' : ''}
              </small>
            </div>
            <div className={styles.sessionActions}>
              <Button variant="ghost" size="sm" onClick={() => setShowWire((v) => !v)} aria-expanded={showWire}>
                {showWire ? 'Hide the requests' : 'Show the requests'}
              </Button>
              <Button variant="ghost" size="sm" onClick={reset}>
                Try another
              </Button>
            </div>
          </div>

          <div className={styles.gallery}>
            <div className={styles.card}>
              <div className={styles.cardHead}>
                <span className={styles.cardTitle}>Your photo</span>
                <span className={styles.pill}>original</span>
              </div>
              <div className={styles.media}>
                {source.url && (
                  <button
                    type="button"
                    className={styles.mediaButton}
                    onClick={() => setView({ shots: [{ src: source.url!, alt: 'Your photo, as uploaded' }], at: 0 })}
                  >
                    <img src={source.url} alt="The photo as uploaded" />
                  </button>
                )}
              </div>
              <div className={styles.cardFoot}>
                <span>as uploaded</span>
              </div>
            </div>

            {runs
              .filter((r) => featureOf(r)?.kind === 'image' || featureOf(r)?.kind === 'video')
              .map((r) => {
                const f = featureOf(r)!;
                const st = stateOf(r);
                const isVideo = f.kind === 'video';
                const main = r.row?.outputs?.find((o) => o.role === (isVideo ? 'video' : 'image'));
                const src = main?.key ? r.urls[main.key] : undefined;
                const shots = isVideo ? [] : shotsOf(r);
                return (
                  <div key={r.feature} className={styles.card} data-state={st}>
                    <div className={styles.cardHead}>
                      <span className={styles.cardTitle}>{f.label}</span>
                      <span className={styles.pill} data-state={st}>
                        {st}
                      </span>
                    </div>
                    <div className={styles.media} data-video={isVideo} data-transparent={r.feature === 'cutout'}>
                      {st === 'done' && src ? (
                        isVideo ? (
                          <video src={src} controls playsInline preload="metadata" />
                        ) : (
                          <button
                            type="button"
                            className={styles.mediaButton}
                            onClick={() => setView({ shots, at: Math.min(1, shots.length - 1) })}
                            title="Open at full size"
                          >
                            <img src={src} alt={f.label} />
                          </button>
                        )
                      ) : st === 'failed' ? (
                        <div className={styles.failed}>{stateWords(r)}</div>
                      ) : (
                        <>
                          {source.url && <img className={styles.ghost} src={source.url} alt="" />}
                          <div className={styles.scan} aria-hidden="true" />
                          <div className={styles.stageText} aria-live="polite">
                            {stateWords(r)}
                            {r.progress ? ` · ${r.progress}%` : ''}
                          </div>
                          <div className={styles.progress} aria-hidden="true">
                            <span style={{ width: `${r.progress}%` }} />
                          </div>
                        </>
                      )}
                    </div>
                    {foot(
                      r,
                      st === 'done' && !isVideo && shots.length > 0 ? (
                        <button type="button" className={styles.action} onClick={() => setView({ shots, at: Math.min(1, shots.length - 1) })}>
                          <Icon.expand /> View
                        </button>
                      ) : st === 'done' && isVideo && src ? (
                        <a className={styles.action} href={src} target="_blank" rel="noreferrer">
                          <Icon.expand /> Open
                        </a>
                      ) : undefined,
                    )}
                    {wireFor === r.feature && <div style={{ padding: 'var(--s-3)' }}>{wireBlock(r)}</div>}
                  </div>
                );
              })}
          </div>

          <div className={styles.words}>
            {runs
              .filter((r) => r.feature === 'check')
              .map((r) => {
                const verdict = r.row?.outputs?.find((o) => o.role === 'text')?.text as Verdict | undefined;
                const st = stateOf(r);
                return (
                  <div key={r.feature} className={styles.doc} data-state={st}>
                    <div className={styles.docHead}>
                      <div>
                        <div className={styles.eyebrow}>Product check</div>
                        {verdict ? (
                          <span className={styles.verdict} data-v={verdict.verdict}>
                            {verdict.verdict.replace('_', ' ')} · {Math.round(verdict.confidence * 100)}%
                          </span>
                        ) : (
                          <span className={styles.muted}>{stateWords(r)}</span>
                        )}
                      </div>
                      <div className={styles.actions}>
                        <span className={styles.muted} style={{ fontFamily: 'var(--f-mono)', fontSize: 'var(--t-1)', alignSelf: 'center' }}>
                          {r.row?.credits ?? featureOf(r)?.credits ?? 0} cr · {took(r)}
                        </span>
                        <button
                          type="button"
                          className={styles.action}
                          aria-pressed={wireFor === r.feature}
                          onClick={() => setWireFor((w) => (w === r.feature ? null : r.feature))}
                        >
                          <Icon.code /> Request
                        </button>
                      </div>
                    </div>
                    {verdict && (
                      <p className={styles.para}>
                        {verdict.saw}
                        {verdict.issues.length > 0 && <> — {verdict.issues.map((i) => ISSUE_WORDS[i] ?? i).join(', ')}</>}
                        <br />
                        <span className={styles.muted}>{verdict.advice}</span>
                      </p>
                    )}
                    {wireFor === r.feature && wireBlock(r)}
                  </div>
                );
              })}

            {runs
              .filter((r) => r.feature === 'copy')
              .map((r) => {
                const copy = r.row?.outputs?.find((o) => o.role === 'text')?.text as Copy | undefined;
                const d = copy?.description;
                const st = stateOf(r);
                const plain = d?.long
                  ? [copy?.seo?.title, '', d.long, '', ...(d.bullets ?? []).map((b) => `• ${b}`), '', ...(d.specs ?? []).map((s) => `${s.label}: ${s.value}`)]
                      .filter((l) => l !== undefined)
                      .join('\n')
                      .trim()
                  : '';
                return (
                  <div key={r.feature} className={styles.doc} data-state={st}>
                    <div className={styles.docHead}>
                      <div>
                        <div className={styles.eyebrow}>Listing copy</div>
                        <h3>{copy?.seo?.title ?? (st === 'done' ? 'Listing copy' : stateWords(r))}</h3>
                      </div>
                      <div className={styles.actions}>
                        <span className={styles.muted} style={{ fontFamily: 'var(--f-mono)', fontSize: 'var(--t-1)', alignSelf: 'center' }}>
                          {r.row?.credits ?? featureOf(r)?.credits ?? 0} cr · {took(r)}
                        </span>
                        {plain && (
                          <button type="button" className={styles.action} onClick={() => void copyText(r, plain)}>
                            <Icon.copy /> {copied === r.feature ? 'Copied' : 'Copy text'}
                          </button>
                        )}
                        {st === 'done' && r.row && (
                          <a className={styles.action} href={api.library.downloadUrl(workspaceId, r.row.id)}>
                            <Icon.external /> Download
                          </a>
                        )}
                        {st === 'failed' && (
                          <button type="button" className={styles.action} onClick={() => void start(source.asset, [r.feature], source.title)}>
                            Run again
                          </button>
                        )}
                        <button
                          type="button"
                          className={styles.action}
                          aria-pressed={wireFor === r.feature}
                          onClick={() => setWireFor((w) => (w === r.feature ? null : r.feature))}
                        >
                          <Icon.code /> Request
                        </button>
                      </div>
                    </div>
                    {d?.long && (
                      <>
                        <p className={styles.para}>{d.long}</p>
                        {d.bullets && d.bullets.length > 0 && (
                          <ul className={styles.bullets}>
                            {d.bullets.map((b, i) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ul>
                        )}
                        {d.specs && d.specs.length > 0 && (
                          <dl className={styles.specs}>
                            {d.specs.map((s, i) => (
                              <div key={i}>
                                <dt>{s.label}</dt>
                                <dd>{s.value}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </>
                    )}
                    {st === 'failed' && <p className={styles.para}>{stateWords(r)}</p>}
                    {wireFor === r.feature && wireBlock(r)}
                  </div>
                );
              })}
          </div>

          {notYet.length > 0 && (
            <div className={styles.more}>
              <span>Same photo, one more:</span>
              {notYet.map((f) => (
                <button key={f.key} type="button" className={styles.chip} disabled={!canAdd(f)} onClick={() => void start(source.asset, [f.key], source.title)}>
                  <Icon.plus width={12} height={12} /> {f.label} <code>{f.credits.toLocaleString()} cr</code>
                </button>
              ))}
            </div>
          )}

          <div className={styles.note}>
            {spent > 0
              ? `${spent.toLocaleString()} credit${spent === 1 ? '' : 's'} spent, on this workspace's balance — the same charge your integration would see.`
              : 'Running on this workspace’s credits; each call is metered exactly as an integration would be.'}
          </div>

          {showWire && (
            <div className={styles.wire}>
              {runs.map((r) => (
                <div key={r.feature}>{wireBlock(r)}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {view && <Lightbox shots={view.shots} startAt={view.at} onClose={() => setView(null)} />}
    </div>
  );
}
