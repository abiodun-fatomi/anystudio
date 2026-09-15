'use client';
/**
 * The playground: run the API on a photo without writing a line of code.
 *
 * The menu comes from the API — each feature a capability with its
 * parameters decided server-side and priced from the live credit table —
 * so what is shown is what an integration would pay. Pick the features,
 * say what the product is, give it a photo (drop, choose, paste, or a
 * link), and each becomes a real generation: charged to the workspace's
 * credits, streamed as it runs, shown as the picture, the verdict, the copy
 * or the clip, with the exact request an integration would send under it.
 * Every run is real provider spend, so the workspace has a daily allowance
 * on top of its credits; the page shows it and stops at it.
 */
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
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

const DEFAULT_PICK: PlaygroundFeatureKey[] = ['check', 'background', 'copy'];

const resetWords = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  const h = Math.max(0, Math.floor(ms / 3_600_000));
  const m = Math.max(0, Math.floor((ms % 3_600_000) / 60_000));
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
};

const looksLikeImageUrl = (s: string) => /^https?:\/\/\S+\.(jpe?g|png|webp|gif|avif)(\?\S*)?$/i.test(s.trim());

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
  const streams = useRef<EventSource[]>([]);

  useEffect(() => () => streams.current.forEach((s) => s.close()), []);

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
      const { generation } = await api.generations.get(workspaceId, id);
      const keys = (generation.outputs ?? []).map((o) => o.key).filter(Boolean);
      const urls = keys.length ? (await api.media.urls(workspaceId, keys)).urls : {};
      patch(key, (r) => ({ ...r, row: generation, urls, stage: generation.status === 'SUCCEEDED' ? 'done' : 'failed' }));
      void refreshBalance();
    } catch (e) {
      patch(key, (r) => ({ ...r, error: e instanceof ApiError ? e.message : 'Could not read the result.' }));
    }
  }

  function watch(key: PlaygroundFeatureKey, id: string) {
    const es = new EventSource(api.generations.streamUrl(workspaceId, id));
    streams.current.push(es);
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as { type: string; stage?: string; progress?: number };
        if (e.type === 'stage') patch(key, (r) => ({ ...r, stage: e.stage ?? r.stage, progress: e.progress ?? r.progress }));
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

  async function run(asset: MediaAssetRow, pageTitle: string | null) {
    const srcUrl = (await api.media.urls(workspaceId, [asset.key])).urls[asset.key] ?? null;
    const name = title.trim() || pageTitle;
    setSource({ asset, url: srcUrl, title: name });
    const menu = features ?? [];
    const keys = menu.filter((f) => picked.includes(f.key)).map((f) => f.key);
    setRuns(
      keys.map((feature) => ({
        feature,
        capability: menu.find((f) => f.key === feature)?.capability ?? '',
        row: null,
        stage: 'queued',
        progress: 0,
        urls: {},
        error: null,
      })),
    );
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
      setRuns((rs) => rs.map((r) => ({ ...r, error: message })));
      if (e instanceof ApiError && e.code === 'playground_exhausted') void loadMenu();
    }
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
  };

  const menu = features ?? [];
  const chosen = menu.filter((f) => picked.includes(f.key));
  const cost = chosen.reduce((n, f) => n + f.credits, 0);
  const short = balance !== null && cost > balance;
  const exhausted = allowance !== null && allowance.remaining < picked.length;
  const canRun = picked.length > 0 && !busy && !exhausted && !short;
  const spent = runs.reduce((n, r) => n + (r.row?.status === 'SUCCEEDED' ? r.row.credits : 0), 0);
  const stateWords = (r: Run, failed: string) => r.error ?? (r.row?.status === 'FAILED' ? failed : `${r.stage}${r.progress ? ` · ${r.progress}%` : ''}`);
  const featureOf = (r: Run) => menu.find((f) => f.key === r.feature);

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

  return (
    <div className={dev.group} onPaste={onPaste}>
      <div className={dev.groupHead}>
        <div>
          <div className={dev.groupTitle}>Playground</div>
          <p className={dev.groupLede}>
            The API on one of your photos, without writing code. Every call here is a real one: priced as your integration would be charged, queued and streamed
            the same way, and shown with the request that made it.
          </p>
        </div>
        {source && (
          <Button variant="ghost" onClick={reset}>
            Try another
          </Button>
        )}
      </div>

      <div className={styles.allowance} aria-live="polite">
        {allowance ? (
          <>
            <span className={styles.meter} data-empty={allowance.remaining === 0}>
              <span style={{ width: `${Math.round((allowance.usedToday / allowance.dailyLimit) * 100)}%` }} />
            </span>
            <span>
              <strong style={{ color: 'var(--ink)' }}>
                {allowance.remaining} of {allowance.dailyLimit}
              </strong>{' '}
              playground calls left today
              {allowance.remaining === 0 ? ` — resets ${resetWords(allowance.resetsAt)}` : ''}. Your API keys are not limited this way.
            </span>
          </>
        ) : (
          <Skeleton width={260} height={14} />
        )}
      </div>

      {!source && (
        <>
          {features === null ? (
            <Skeleton height={200} />
          ) : (
            <div className={styles.picks} role="group" aria-label="What to run">
              {menu.map((f) => {
                const on = picked.includes(f.key);
                return (
                  <button
                    key={f.key}
                    type="button"
                    className={styles.pick}
                    aria-pressed={on}
                    data-kind={f.kind}
                    onClick={() => setPicked((p) => (on ? p.filter((x) => x !== f.key) : [...p, f.key]))}
                  >
                    <div>
                      <strong>{f.label}</strong>
                      <span>{f.help}</span>
                    </div>
                    <code className={styles.cost}>{f.credits.toLocaleString()} cr</code>
                  </button>
                );
              })}
            </div>
          )}

          <div className={styles.about}>
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

          <div className={styles.source}>
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
              <strong>
                {picked.length === 0
                  ? 'Pick at least one thing to run'
                  : `Drop a product photo here — ${cost.toLocaleString()} credit${cost === 1 ? '' : 's'}${balance !== null ? ` of your ${balance.toLocaleString()}` : ''}`}
              </strong>
              <span>or tap to choose one, or paste a copied image · JPEG, PNG or WebP</span>
              <input type="file" accept="image/*" disabled={!canRun} onChange={(e) => e.target.files?.[0] && void fromFile(e.target.files[0])} />
            </label>
            <div className={styles.or}>or paste a link</div>
            <div className={styles.urlrow}>
              <Input
                className={styles.inp}
                placeholder="A listing page, or the image address itself"
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
            {busy && <div className={styles.note}>{busy}</div>}
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
          </div>
        </>
      )}

      {source && (
        <div className={styles.results}>
          {source.title && (
            <div className={styles.line}>
              <strong>{source.title}</strong>
              <span style={{ color: 'var(--muted)' }}>what the check compares against, and what the copy and the reel are named after</span>
            </div>
          )}

          <div className={styles.grid}>
            <div className={styles.shot}>
              {source.url && <img src={source.url} alt="The photo as uploaded" />}
              <span className={styles.tag}>Yours</span>
            </div>
            {runs
              .filter((r) => featureOf(r)?.kind === 'image')
              .map((r) => {
                const image = r.row?.outputs?.find((o) => o.role === 'image');
                const f = featureOf(r)!;
                return (
                  <div key={r.feature} className={styles.shot} data-transparent={r.feature === 'cutout'}>
                    {image && r.urls[image.key] ? (
                      <img src={r.urls[image.key]} alt={f.label} />
                    ) : (
                      <span className={styles.wait}>{stateWords(r, 'Could not make it — credits returned')}</span>
                    )}
                    <span className={styles.tag}>{f.label}</span>
                  </div>
                );
              })}
            {runs
              .filter((r) => featureOf(r)?.kind === 'video')
              .map((r) => {
                const video = r.row?.outputs?.find((o) => o.role === 'video');
                const f = featureOf(r)!;
                return (
                  <div key={r.feature} className={styles.shot} data-video="true">
                    {video && r.urls[video.key] ? (
                      <video src={r.urls[video.key]} controls playsInline preload="metadata" />
                    ) : (
                      <span className={styles.wait}>{stateWords(r, 'Could not make it — credits returned')}</span>
                    )}
                    <span className={styles.tag}>{f.label}</span>
                  </div>
                );
              })}
          </div>

          {runs
            .filter((r) => r.feature === 'check')
            .map((r) => {
              const verdict = r.row?.outputs?.find((o) => o.role === 'text')?.text as Verdict | undefined;
              return (
                <div key={r.feature} className={styles.line} data-status={r.row?.status}>
                  <strong>Product check</strong>
                  {verdict ? (
                    <>
                      <span className={styles.verdict} data-v={verdict.verdict}>
                        {verdict.verdict.replace('_', ' ')}
                      </span>{' '}
                      {verdict.saw}
                      {verdict.issues.length > 0 && <> — {verdict.issues.map((i) => ISSUE_WORDS[i] ?? i).join(', ')}</>}
                      <br />
                      <span style={{ color: 'var(--muted)' }}>{verdict.advice}</span>
                    </>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>{stateWords(r, 'Could not check it — credit returned')}</span>
                  )}
                </div>
              );
            })}

          {runs
            .filter((r) => r.feature === 'copy')
            .map((r) => {
              const copy = r.row?.outputs?.find((o) => o.role === 'text')?.text as Copy | undefined;
              const d = copy?.description;
              return (
                <div key={r.feature} className={styles.line} data-status={r.row?.status}>
                  <strong>{copy?.seo?.title ?? 'Listing copy'}</strong>
                  {d?.long ? (
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
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>{stateWords(r, 'Could not write it — credits returned')}</span>
                  )}
                </div>
              );
            })}

          <div className={styles.note}>
            {spent > 0
              ? `${spent.toLocaleString()} credit${spent === 1 ? '' : 's'} spent, on this workspace's balance — the same charge your integration would see.`
              : 'Running on this workspace’s credits; each call is metered exactly as an integration would be.'}
          </div>

          <div>
            <Button variant="ghost" size="sm" onClick={() => setShowWire((v) => !v)} aria-expanded={showWire}>
              {showWire ? 'Hide the requests' : 'Show the requests your code would send'}
            </Button>
          </div>
          {showWire && (
            <div className={styles.wire}>
              {runs.map((r) => {
                const f = featureOf(r);
                const clientKey = `playground:${source.asset.id.slice(0, 8)}:${r.feature}:v1`;
                return (
                  <div key={r.feature} className={styles.wire}>
                    <div className={styles.wireHead}>
                      {f?.label ?? r.feature} <code>{clientKey}</code>
                    </div>
                    <pre className={dev.code}>{curlFor(r.capability, r.row?.input ?? { sourceKey: source.asset.key }, keyPrefix, clientKey)}</pre>
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
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
