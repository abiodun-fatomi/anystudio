'use client';
/**
 * The Studio: one photo in, everything out.
 *
 *   [ SOURCE ]        [ CANVAS ]              [ TOOL ]
 *   upload / pick      the working image       controls, quote, the button
 *                      the tool strip
 *   [ OUTPUTS ] — result cards, newest first, each narrating its own progress
 *
 * The source and the tool live in the URL (?source=…&tool=…), so a studio
 * session survives a refresh and can be handed to someone else. Everything
 * the cards know comes from useGenerations; this file only arranges it.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, type MediaAssetRow } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { TOOLS, coerceParams, toolById, type Tool, type ToolId } from '@/lib/studio/tools';
import { useGenerations, type GenerationCard } from '@/lib/studio/useGenerations';
import { Button, EmptyState, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import { SourcePane } from './SourcePane';
import { ToolPanel } from './ToolPanel';
import { ResultCard } from './ResultCard';
import styles from './studio.module.css';

export default function StudioPage() {
  return <Suspense fallback={null}><Studio /></Suspense>;
}

function Studio() {
  const { workspace, balance } = useApp();
  const { toast } = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const sourceKey = params.get('source');
  const tool = toolById(params.get('tool'));
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceMeta, setSourceMeta] = useState<{ width?: number | null; height?: number | null } | null>(null);
  const [values, setValues] = useState<Record<string, Record<string, unknown>>>({});
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { cards, create, cancel, dismiss, hydrate, resolveUrls, editText, regenerateField } = useGenerations();

  useEffect(() => { void hydrate(); }, [hydrate]);

  // The library's "Make again" leaves the params here; pick them up once.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('anystudio:prefill');
      if (!raw) return;
      sessionStorage.removeItem('anystudio:prefill');
      const pre = JSON.parse(raw) as { toolId?: string; params?: Record<string, unknown> };
      if (pre.toolId && pre.params) { const { sourceKey: _s, ...rest } = pre.params; setValues((all) => ({ ...all, [pre.toolId!]: rest })); }
    } catch { /* nothing to prefill */ }
  }, []);

  const setUrl = useCallback((next: { source?: string | null; tool?: ToolId }) => {
    const q = new URLSearchParams(params.toString());
    if (next.source !== undefined) { if (next.source) q.set('source', next.source); else q.delete('source'); }
    if (next.tool) q.set('tool', next.tool);
    router.replace(`/studio?${q.toString()}`, { scroll: false });
  }, [params, router]);

  // Resolve the source key to something the canvas can draw.
  useEffect(() => {
    let live = true;
    setSourceUrl(null);
    if (!sourceKey) return;
    api.media.urls(workspace.id, [sourceKey]).then(({ urls }) => { if (live) setSourceUrl(urls[sourceKey] ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, [workspace.id, sourceKey]);

  const selectSource = useCallback((asset: MediaAssetRow) => {
    setSourceMeta({ width: asset.width, height: asset.height });
    setUrl({ source: asset.key });
  }, [setUrl]);

  const toolValues = useMemo(() => ({ ...tool.defaults, ...(values[tool.id] ?? {}) }), [tool, values]);
  const setValue = (key: string, v: unknown) => setValues((all) => ({ ...all, [tool.id]: { ...(all[tool.id] ?? {}), [key]: v } }));

  const generate = useCallback(async (t: Tool, v: Record<string, unknown>, credits: number, src: string | null) => {
    setBusy(true);
    const p = coerceParams(t, v);
    if (t.needsSource || src) { if (src) p.sourceKey = src; }
    if (t.needsSource && !src) { setBusy(false); return; }
    const r = await create({ toolId: t.id, capability: t.capability, params: p, credits, sourceKey: src ?? undefined, costCode: t.costCodeFor?.(p) });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 402) toast({ title: 'Not enough credits', body: 'Top up and this will be here waiting.', tone: 'warn', action: { label: 'Top up', onClick: () => router.push('/billing/plans') } });
      else toast({ title: 'That did not go through', body: r.message, tone: 'danger' });
    } else {
      document.getElementById('outputs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [create, toast, router]);

  const again = useCallback((card: GenerationCard) => {
    const t = toolById(card.toolId);
    setValues((all) => ({ ...all, [t.id]: { ...card.params } }));
    setUrl({ tool: t.id, source: card.sourceKey ?? sourceKey });
    void generate(t, card.params, card.credits, card.sourceKey ?? sourceKey);
  }, [generate, setUrl, sourceKey]);

  const useAsSource = useCallback((key: string) => {
    setSourceMeta(null);
    setUrl({ source: key });
    setRefreshKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [setUrl]);

  const sendToVideo = useCallback((key: string) => {
    setUrl({ source: key, tool: 'video' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [setUrl]);

  const liveCount = cards.filter((c) => c.status === 'QUEUED' || c.status === 'RUNNING' || c.status === 'requesting').length;

  return (
    <div className="rise">
      <div className={styles.studio}>
        <SourcePane selected={sourceKey} onSelect={selectSource} refreshKey={refreshKey} />

        <section className={`${styles.pane} ${styles.canvas}`} aria-label="Canvas">
          <div className={styles.stage}>
            {sourceKey ? (
              sourceUrl ? <img src={sourceUrl} alt="Your product photo" /> : <div style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>Loading your photo…</div>
            ) : (
              <div className={styles.stageEmpty}>
                <Icon.studio width={36} height={36} />
                <strong>Start with a photo</strong>
                <span>Add one on the left, or write a listing from a name and a few details with no photo at all.</span>
                <Button variant="ghost" size="sm" onClick={() => setUrl({ tool: 'copy' })}>Write a listing instead</Button>
              </div>
            )}
            {sourceKey && sourceMeta?.width && <div className={styles.stageMeta}><span className="mono" style={{ background: 'var(--surface-2)', padding: '4px 8px', borderRadius: 4 }}>{sourceMeta.width}×{sourceMeta.height}</span></div>}
          </div>
          <div className={styles.strip} role="toolbar" aria-label="Tools">
            {TOOLS.map((t) => (
              <button key={t.id} type="button" className={styles.toolBtn} aria-pressed={t.id === tool.id} onClick={() => setUrl({ tool: t.id })} disabled={t.needsSource && !sourceKey} title={t.needsSource && !sourceKey ? 'Add a photo first' : t.label}>
                {Icon[t.icon]({})}<span>{t.short}</span>
              </button>
            ))}
          </div>
        </section>

        <ToolPanel tool={tool} values={toolValues} onChange={setValue} hasSource={Boolean(sourceKey)} busy={busy} onGenerate={(q) => void generate(tool, toolValues, q.credits, sourceKey)} />
      </div>
      <div className={styles.mobileSpacer} />

      <section id="outputs" className={styles.outputs} aria-label="Results">
        <div className={styles.outputsHead}>
          <h2>Results</h2>
          <span className="mono">{liveCount > 0 ? `${liveCount} in progress` : balance !== null ? `${balance.toLocaleString()} credits` : ''}</span>
        </div>
        {cards.length === 0 ? (
          <EmptyState icon={<Icon.library />} title="Nothing made yet" body="Pick a tool, press the button, and watch it happen here. A failed generation gives the credits straight back." />
        ) : (
          <div className={styles.grid}>
            {cards.map((c) => (
              <ResultCard key={c.clientKey} card={c} onUseAsSource={useAsSource} onSendToVideo={sendToVideo} onAgain={again} onCancel={(k) => void cancel(k)} onDismiss={dismiss} onRefreshUrls={(k, keys) => void resolveUrls(k, keys)} onEditText={(k, f, v) => void editText(k, f, v)} onRegenerateField={regenerateField} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
