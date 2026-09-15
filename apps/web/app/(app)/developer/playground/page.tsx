'use client';
/**
 * The playground: run the API on a photo without writing a line of code.
 *
 * Pick the calls, give it a photo or a listing link, and each call becomes
 * a real generation — charged to the workspace's credits, streamed as it
 * runs, shown as the picture, the verdict or the copy, and, under each, the
 * exact request an integration would send and the exact row that came back.
 * Because every run is real provider spend, the workspace has a daily
 * allowance on top of its credits; the page shows it and stops at it.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api, ApiError, type DevKey, type GenerationRow, type MediaAssetRow, type PlaygroundAllowance, type PlaygroundCapability } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { uploadFile } from '@/lib/upload';
import { Button, Input, Skeleton } from '@/components/ui';
import dev from '../developer.module.css';
import styles from './playground.module.css';

interface Choice {
  capability: PlaygroundCapability;
  label: string;
  help: string;
  credits: number;
  params: (sourceKey: string, title: string | null) => Record<string, unknown>;
}

/** The three calls the platforms page promises, priced as the seed prices them. */
const CHOICES: Choice[] = [
  {
    capability: 'INSPECT',
    label: 'Product check',
    help: 'Is this a usable product photo, and is it the product the listing says?',
    credits: 1,
    params: (sourceKey, title) => ({ sourceKey, ...(title ? { declared: { name: title } } : {}) }),
  },
  {
    capability: 'BACKGROUND_REPLACE',
    label: 'Clean background',
    help: 'The same product on a plain studio background, relit, with a shadow.',
    credits: 10,
    params: (sourceKey) => ({ sourceKey, prompt: 'A plain warm white studio background, soft even light', shadow: true, relight: true }),
  },
  {
    capability: 'TEXT_GENERATE',
    label: 'Listing copy',
    help: 'A description no other listing is using, written from the photo.',
    credits: 2,
    params: (sourceKey, title) => ({ sourceKey, ...(title ? { productName: title } : {}), language: 'en' }),
  },
];

interface Run {
  capability: PlaygroundCapability;
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

const resetWords = (iso: string) => {
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  const h = Math.max(0, Math.floor(ms / 3_600_000));
  const m = Math.max(0, Math.floor((ms % 3_600_000) / 60_000));
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
};

/** The request as an integration would send it, with the workspace's own key prefix standing in for the secret. */
function curlFor(choice: Choice, sourceKey: string, title: string | null, prefix: string | null, clientKey: string): string {
  const body = { capability: choice.capability, params: choice.params(sourceKey, title), clientKey };
  return [
    `curl -X POST https://api.anystudio.ai/api/v1/generations \\`,
    `  -H "Authorization: Bearer ${prefix ? `${prefix}…` : 'as_test_…'}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(body, null, 2).replace(/\n/g, '\n      ')}'`,
  ].join('\n');
}

export default function PlaygroundPage() {
  const { workspace, refreshBalance } = useApp();
  const workspaceId = workspace.id;
  const [allowance, setAllowance] = useState<PlaygroundAllowance | null>(null);
  const [keyPrefix, setKeyPrefix] = useState<string | null>(null);
  const [picked, setPicked] = useState<PlaygroundCapability[]>(['INSPECT', 'BACKGROUND_REPLACE', 'TEXT_GENERATE']);
  const [url, setUrl] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<{ asset: MediaAssetRow; url: string | null; title: string | null } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [showWire, setShowWire] = useState(false);
  const streams = useRef<EventSource[]>([]);

  useEffect(() => () => streams.current.forEach((s) => s.close()), []);

  const loadAllowance = useCallback(async () => {
    try {
      setAllowance(await api.developer.playground(workspaceId));
    } catch {
      /* the page still works without the figure; the API enforces it either way */
    }
  }, [workspaceId]);
  useEffect(() => {
    void loadAllowance();
    api.developer
      .keys(workspaceId)
      .then((ks: DevKey[]) => setKeyPrefix(ks.find((k) => !k.revokedAt)?.prefix ?? null))
      .catch(() => setKeyPrefix(null));
  }, [workspaceId, loadAllowance]);

  const patch = (cap: PlaygroundCapability, fn: (r: Run) => Run) => setRuns((rs) => rs.map((r) => (r.capability === cap ? fn(r) : r)));

  async function finish(cap: PlaygroundCapability, id: string) {
    try {
      const { generation } = await api.generations.get(workspaceId, id);
      const keys = (generation.outputs ?? []).map((o) => o.key).filter(Boolean);
      const urls = keys.length ? (await api.media.urls(workspaceId, keys)).urls : {};
      patch(cap, (r) => ({ ...r, row: generation, urls, stage: generation.status === 'SUCCEEDED' ? 'done' : 'failed' }));
      void refreshBalance();
    } catch (e) {
      patch(cap, (r) => ({ ...r, error: e instanceof ApiError ? e.message : 'Could not read the result.' }));
    }
  }

  function watch(cap: PlaygroundCapability, id: string) {
    const es = new EventSource(api.generations.streamUrl(workspaceId, id));
    streams.current.push(es);
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as { type: string; stage?: string; progress?: number };
        if (e.type === 'stage') patch(cap, (r) => ({ ...r, stage: e.stage ?? r.stage, progress: e.progress ?? r.progress }));
        if (e.type === 'done') {
          es.close();
          void finish(cap, id);
        }
      } catch {
        /* a malformed event is not worth a broken card */
      }
    };
    es.onerror = () => {
      es.close();
      void finish(cap, id);
    };
  }

  async function run(asset: MediaAssetRow, title: string | null) {
    const srcUrl = (await api.media.urls(workspaceId, [asset.key])).urls[asset.key] ?? null;
    setSource({ asset, url: srcUrl, title });
    const caps = CHOICES.filter((c) => picked.includes(c.capability)).map((c) => c.capability);
    setRuns(caps.map((capability) => ({ capability, row: null, stage: 'queued', progress: 0, urls: {}, error: null })));
    try {
      const out = await api.developer.playgroundRun(workspaceId, { assetId: asset.id, capabilities: caps, ...(title ? { title } : {}) });
      setAllowance(out.allowance);
      void refreshBalance();
      for (const r of out.runs) {
        patch(r.capability, (cur) => ({ ...cur, row: r.generation, stage: r.generation.stage ?? 'queued' }));
        if (r.generation.status === 'SUCCEEDED' || r.generation.status === 'FAILED') void finish(r.capability, r.generation.id);
        else watch(r.capability, r.generation.id);
      }
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Could not start it.';
      setRuns((rs) => rs.map((r) => ({ ...r, error: message })));
      if (e instanceof ApiError && e.code === 'playground_exhausted') void loadAllowance();
    }
  }

  async function fromFile(file: File) {
    setError(null);
    setBusy('Uploading your photo…');
    try {
      const asset = await uploadFile(workspaceId, file);
      await run(asset, null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not upload that photo.');
    } finally {
      setBusy(null);
    }
  }

  async function fromLink() {
    if (!url.trim()) return;
    setError(null);
    setBusy('Reading the page and fetching its picture…');
    try {
      const got = await api.media.fromUrl(workspaceId, url.trim());
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
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && canRun) void fromFile(f);
  };

  const cost = CHOICES.filter((c) => picked.includes(c.capability)).reduce((n, c) => n + c.credits, 0);
  const exhausted = allowance !== null && allowance.remaining < picked.length;
  const canRun = picked.length > 0 && !busy && !exhausted;

  const inspect = runs.find((r) => r.capability === 'INSPECT');
  const bg = runs.find((r) => r.capability === 'BACKGROUND_REPLACE');
  const copy = runs.find((r) => r.capability === 'TEXT_GENERATE');
  const verdict = inspect?.row?.outputs?.find((o) => o.role === 'text')?.text as Verdict | undefined;
  const bgImage = bg?.row?.outputs?.find((o) => o.role === 'image');
  const copyText = copy?.row?.outputs?.find((o) => o.role === 'text')?.text as
    { description?: { long?: string; short?: string }; seo?: { title?: string } } | undefined;
  const spent = runs.reduce((n, r) => n + (r.row?.status === 'SUCCEEDED' ? r.row.credits : 0), 0);
  const stateWords = (r: Run | undefined, failed: string) =>
    r?.error ?? (r?.row?.status === 'FAILED' ? failed : `${r?.stage ?? 'queued'}${r?.progress ? ` · ${r.progress}%` : ''}`);

  return (
    <div className={dev.group}>
      <div className={dev.groupHead}>
        <div>
          <div className={dev.groupTitle}>Playground</div>
          <p className={dev.groupLede}>
            The API on one of your photos, without writing code. Every call here is a real one: charged to this workspace&apos;s credits, queued and streamed
            exactly as it would be from your integration, and shown with the request that made it.
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
          <div className={styles.picks} role="group" aria-label="Calls to make">
            {CHOICES.map((c) => {
              const on = picked.includes(c.capability);
              return (
                <button
                  key={c.capability}
                  type="button"
                  className={styles.pick}
                  aria-pressed={on}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== c.capability) : [...p, c.capability]))}
                >
                  <div>
                    <strong>{c.label}</strong>
                    <span>{c.help}</span>
                  </div>
                  <code className={styles.cost}>{c.credits} cr</code>
                </button>
              );
            })}
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
              <strong>{picked.length ? `Drop a product photo here — ${cost} credit${cost === 1 ? '' : 's'}` : 'Pick at least one call above'}</strong>
              <span>or tap to choose one · JPEG, PNG or WebP</span>
              <input type="file" accept="image/*" disabled={!canRun} onChange={(e) => e.target.files?.[0] && void fromFile(e.target.files[0])} />
            </label>
            <div className={styles.or}>or paste a listing</div>
            <div className={styles.urlrow}>
              <Input
                className={styles.inp}
                placeholder="https://yourmarketplace.ng/products/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canRun && void fromLink()}
                aria-label="Listing link"
                disabled={!canRun}
              />
              <Button onClick={fromLink} disabled={!url.trim() || !canRun}>
                Fetch it
              </Button>
            </div>
            {busy && <div className={styles.note}>{busy}</div>}
            {error && (
              <div className={styles.note} data-tone="warn">
                {error}
              </div>
            )}
            {exhausted && allowance && (
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
              <span style={{ color: 'var(--muted)' }}>read from the page — the check compares the picture against it, and the copy is named after it</span>
            </div>
          )}
          <div className={styles.pair}>
            <div className={styles.shot}>
              {source.url && <img src={source.url} alt="The photo as uploaded" />}
              <span className={styles.tag}>Yours</span>
            </div>
            {bg && (
              <div className={styles.shot}>
                {bgImage && bg.urls[bgImage.key] ? (
                  <img src={bg.urls[bgImage.key]} alt="The same product on a clean background" />
                ) : (
                  <span className={styles.wait}>{stateWords(bg, 'Could not make it — credits returned')}</span>
                )}
                <span className={styles.tag}>Studio</span>
              </div>
            )}
          </div>

          {inspect && (
            <div className={styles.line} data-status={inspect.row?.status}>
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
                <span style={{ color: 'var(--muted)' }}>{stateWords(inspect, 'Could not check it — credit returned')}</span>
              )}
            </div>
          )}

          {copy && (
            <div className={styles.line} data-status={copy.row?.status}>
              <strong>{copyText?.seo?.title ?? 'Listing copy'}</strong>
              {copyText?.description?.long ? (
                copyText.description.long
              ) : (
                <span style={{ color: 'var(--muted)' }}>{stateWords(copy, 'Could not write it — credits returned')}</span>
              )}
            </div>
          )}

          <div className={styles.note}>
            {spent > 0
              ? `${spent} credit${spent === 1 ? '' : 's'} spent, on this workspace's balance — the same charge your integration would see.`
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
                const choice = CHOICES.find((c) => c.capability === r.capability)!;
                const clientKey = `playground:${source.asset.id.slice(0, 8)}:${r.capability.toLowerCase()}:v1`;
                return (
                  <div key={r.capability} className={styles.wire}>
                    <div className={styles.wireHead}>
                      {choice.label} <code>{clientKey}</code>
                    </div>
                    <pre className={dev.code}>{curlFor(choice, source.asset.key, source.title, keyPrefix, clientKey)}</pre>
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
