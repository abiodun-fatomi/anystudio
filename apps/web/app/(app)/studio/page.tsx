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
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, type CatalogueProductView, type MediaAssetRow } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { moneyMinor } from '@/lib/billing/money';
import { TOOLS, bringsItsOwnSource, cardSourceFor, coerceParams, toolById, type Tool, type ToolId } from '@/lib/studio/tools';
import { acceptsSourceKey } from '@anystudio/shared';
import { useGenerations, type GenerationCard } from '@/lib/studio/useGenerations';
import { Button, EmptyState, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import { SourcePane } from './SourcePane';
import { ToolPanel } from './ToolPanel';
import { Lightbox } from './Lightbox';
import { ResultCard } from './ResultCard';
import styles from './studio.module.css';

export default function StudioPage() {
  return (
    <Suspense fallback={null}>
      <Studio />
    </Suspense>
  );
}

function Studio() {
  const { workspace, balance, postpaid, paused } = useApp();
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
  // How the photo sits in the fixed stage: the whole picture (fit) or the box
  // filled edge to edge (fill). Remembered per browser.
  const [stageFit, setStageFit] = useState<'fit' | 'fill'>('fit');
  useEffect(() => {
    try {
      if (localStorage.getItem('anystudio:stage-fit') === 'fill') setStageFit('fill');
    } catch {
      /* fine */
    }
  }, []);
  const toggleStageFit = () => {
    const next = stageFit === 'fit' ? 'fill' : 'fit';
    setStageFit(next);
    try {
      localStorage.setItem('anystudio:stage-fit', next);
    } catch {
      /* fine */
    }
  };
  const [viewer, setViewer] = useState(false);
  const { cards, create, cancel, dismiss, hydrate, resolveUrls, editText, regenerateField, unlock } = useGenerations();
  const [unlockPrice, setUnlockPrice] = useState<number | null>(null);
  useEffect(() => {
    api.audio
      .unlockPrice()
      .then((p) => setUnlockPrice(p.credits))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // The library's "Make again" leaves the params here; pick them up once.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('anystudio:prefill');
      if (!raw) return;
      sessionStorage.removeItem('anystudio:prefill');
      const pre = JSON.parse(raw) as { toolId?: string; params?: Record<string, unknown> };
      if (pre.toolId && pre.params) {
        const t = toolById(pre.toolId);
        const { sourceKey: _s, ...rest } = pre.params;
        setValues((all) => ({ ...all, [t.id]: t.fields.some((f) => f.kind === 'file' && f.key === 'sourceKey') ? pre.params! : rest }));
      }
    } catch {
      /* nothing to prefill */
    }
  }, []);

  const setUrl = useCallback(
    (next: { source?: string | null; tool?: ToolId }) => {
      const q = new URLSearchParams(params.toString());
      if (next.source !== undefined) {
        if (next.source) q.set('source', next.source);
        else q.delete('source');
        // A product handed over on the URL has done its job once its picture is the source.
        q.delete('product');
      }
      if (next.tool) q.set('tool', next.tool);
      router.replace(`/studio?${q.toString()}`, { scroll: false });
    },
    [params, router],
  );

  // Resolve the source key to something the canvas can draw.
  useEffect(() => {
    let live = true;
    setSourceUrl(null);
    if (!sourceKey) return;
    api.media
      .urls(workspace.id, [sourceKey])
      .then(({ urls }) => {
        if (live) setSourceUrl(urls[sourceKey] ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace.id, sourceKey]);

  const selectSource = useCallback(
    (asset: MediaAssetRow) => {
      setSourceMeta({ width: asset.width, height: asset.height });
      setUrl({ source: asset.key });
    },
    [setUrl],
  );

  // A product from the catalogue: its first picture is the source, and
  // every tool that asks for a name, price, details or product key already
  // knows them. Arrives as ?product= from the Catalogue page, or from the
  // picker in the source pane.
  const useProduct = useCallback(
    (p: CatalogueProductView) => {
      const first = p.images.find((i) => i.key);
      // Either way the URL is rewritten, which also drops ?product= so a refresh does not start over.
      setUrl({ source: first?.key ?? sourceKey });
      setSourceMeta(null);
      const price = p.priceMinor !== null && p.currency ? moneyMinor(p.priceMinor, p.currency) : '';
      setValues((all) => {
        const next = { ...all };
        for (const t of TOOLS) {
          const keys = new Set(t.fields.map((f) => f.key));
          const patch: Record<string, unknown> = {};
          if (keys.has('productName')) patch.productName = p.title;
          if (keys.has('price') && price) patch.price = price;
          if (keys.has('details') && p.description) patch.details = p.description.slice(0, 2000);
          if (keys.has('productKey')) patch.productKey = p.productKey;
          if (Object.keys(patch).length) next[t.id] = { ...(next[t.id] ?? {}), ...patch };
        }
        return next;
      });
      toast({ title: `Starting from ${p.title}`, body: 'Name, price and details are filled in for every tool.', tone: 'ok' });
    },
    [setUrl, toast, sourceKey],
  );
  const useProductRef = useRef(useProduct);
  useProductRef.current = useProduct;
  const productParam = params.get('product');
  useEffect(() => {
    if (!productParam) return;
    let live = true;
    api.catalogue
      .product(workspace.id, productParam)
      .then((p) => {
        if (!live) return;
        useProductRef.current(p);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [productParam, workspace.id]);

  // The photo on the canvas was removed from the strip: clear the canvas too.
  const sourceRemoved = useCallback(
    (asset: MediaAssetRow) => {
      if (asset.key === sourceKey) {
        setSourceMeta(null);
        setUrl({ source: null });
      }
    },
    [sourceKey, setUrl],
  );

  const toolValues = useMemo(() => ({ ...tool.defaults, ...(values[tool.id] ?? {}) }), [tool, values]);
  const setValue = (key: string, v: unknown) => setValues((all) => ({ ...all, [tool.id]: { ...(all[tool.id] ?? {}), [key]: v } }));

  const generate = useCallback(
    async (t: Tool, v: Record<string, unknown>, credits: number, src: string | null) => {
      setBusy(true);
      const p = coerceParams(t, v);
      // A tool that brings its own file (a video to translate) keeps it; the canvas photo is for the rest.
      const ownsSource = bringsItsOwnSource(t);
      const capability = t.capabilityFor?.(v) ?? t.capability;
      // Only attach the canvas photo to a capability that can actually take
      // one. A key the schema does not know is stripped in silence, and the
      // customer gets a picture of a stranger where they expected their own.
      if (!ownsSource && src && acceptsSourceKey(capability)) p.sourceKey = src;
      if (t.needsSource && !src) {
        setBusy(false);
        return;
      }
      const cardSource = ownsSource ? cardSourceFor(t, p) : (src ?? undefined);
      const r = await create({
        toolId: t.id,
        // The chosen look can decide the capability: a cut-out onto a colour
        // is not the same request as a scene, and costs a fifth as much.
        capability,
        params: p,
        credits,
        sourceKey: cardSource,
        costCode: t.costCodeFor?.(p),
      });
      setBusy(false);
      if (!r.ok) {
        if (r.status === 402)
          toast(
            postpaid
              ? {
                  title: paused ? 'Your organization is paused' : 'The credit line is used up',
                  body: paused
                    ? 'An invoice is overdue. Work resumes the moment it is paid.'
                    : 'Pay the open invoice, or ask us to raise the limit. Your work is saved.',
                  tone: 'warn',
                  action: { label: 'Billing', onClick: () => router.push('/billing') },
                }
              : {
                  title: 'Not enough credits',
                  body: 'Top up and this will be here waiting.',
                  tone: 'warn',
                  action: { label: 'Top up', onClick: () => router.push('/billing/plans') },
                },
          );
        else toast({ title: 'That did not go through', body: r.message, tone: 'danger' });
      } else {
        document.getElementById('outputs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [create, toast, router],
  );

  const again = useCallback(
    (card: GenerationCard) => {
      const t = toolById(card.toolId);
      const ownsSource = bringsItsOwnSource(t);
      setValues((all) => ({ ...all, [t.id]: { ...card.params } }));
      setUrl({ tool: t.id, source: ownsSource ? sourceKey : (card.sourceKey ?? sourceKey) });
      void generate(t, card.params, card.credits, ownsSource ? sourceKey : (card.sourceKey ?? sourceKey));
    },
    [generate, setUrl, sourceKey],
  );

  /**
   * The same settings, back in the panel, with nothing made and nothing
   * charged: the seller changes one thing and taps the button themselves.
   * "Do it again" is the other half of the pair — same settings, straight to
   * the vendor.
   */
  const edit = useCallback(
    (card: GenerationCard) => {
      const t = toolById(card.toolId);
      const ownsSource = bringsItsOwnSource(t);
      setValues((all) => ({ ...all, [t.id]: { ...card.params } }));
      setUrl({ tool: t.id, source: ownsSource ? sourceKey : (card.sourceKey ?? sourceKey) });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast({ title: 'Ready to change', body: 'Your settings are back in the panel. Change what you like, then make it again.' });
    },
    [setUrl, sourceKey, toast],
  );

  const useAsSource = useCallback(
    (key: string) => {
      setSourceMeta(null);
      setUrl({ source: key });
      setRefreshKey((k) => k + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [setUrl],
  );

  const sendToVideo = useCallback(
    (key: string) => {
      setUrl({ source: key, tool: 'video' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [setUrl],
  );

  const liveCount = cards.filter((c) => c.status === 'QUEUED' || c.status === 'RUNNING' || c.status === 'requesting').length;

  return (
    <div className="rise">
      <div className={styles.studio}>
        <SourcePane selected={sourceKey} onSelect={selectSource} onProduct={useProduct} onRemoved={sourceRemoved} refreshKey={refreshKey} />

        <section className={`${styles.pane} ${styles.canvas}`} aria-label="Canvas">
          <div className={styles.stage}>
            {sourceKey ? (
              sourceUrl ? (
                <button type="button" className={styles.stageImg} onClick={() => setViewer(true)} title="See it at full size">
                  <img src={sourceUrl} alt="Your product photo" data-fit={stageFit} />
                </button>
              ) : (
                <div style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>Loading your photo…</div>
              )
            ) : (
              <div className={styles.stageEmpty}>
                <Icon.studio width={36} height={36} />
                <strong>Start with a photo</strong>
                <span>Add one on the left — or make a song, record a voiceover, or translate a video without one.</span>
                <Button variant="ghost" size="sm" onClick={() => setUrl({ tool: 'copy' })}>
                  Write a listing instead
                </Button>
              </div>
            )}
            {sourceKey && sourceMeta?.width && (
              <div className={styles.stageMeta}>
                <span className="mono" style={{ background: 'var(--surface-2)', padding: '4px 8px', borderRadius: 4 }}>
                  {sourceMeta.width}×{sourceMeta.height}
                </span>
              </div>
            )}
            {sourceKey && sourceUrl && (
              <div className={styles.stageTools}>
                <button
                  type="button"
                  onClick={toggleStageFit}
                  aria-pressed={stageFit === 'fill'}
                  title={stageFit === 'fit' ? 'Fill the box' : 'Show the whole photo'}
                >
                  {stageFit === 'fit' ? 'Fit' : 'Fill'}
                </button>
                <button type="button" onClick={() => setViewer(true)} aria-label="See the photo at full size" title="Full size">
                  <Icon.expand width={14} height={14} />
                </button>
              </div>
            )}
          </div>
          {viewer && sourceUrl && (
            <Lightbox
              src={sourceUrl}
              alt="Your product photo"
              meta={sourceMeta?.width ? `${sourceMeta.width}×${sourceMeta.height}` : undefined}
              onClose={() => setViewer(false)}
            />
          )}
          <div className={styles.strip} role="toolbar" aria-label="Tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={styles.toolBtn}
                aria-pressed={t.id === tool.id}
                onClick={() => setUrl({ tool: t.id })}
                disabled={t.needsSource && !sourceKey}
                title={t.needsSource && !sourceKey ? 'Add a photo first' : t.label}
              >
                {Icon[t.icon]({})}
                <span>{t.short}</span>
              </button>
            ))}
          </div>
        </section>

        <ToolPanel
          tool={tool}
          values={toolValues}
          onChange={setValue}
          hasSource={Boolean(sourceKey)}
          sourceKey={sourceKey}
          busy={busy}
          onGenerate={(q) => void generate(tool, toolValues, q.credits, sourceKey)}
        />
      </div>

      <section id="outputs" className={styles.outputs} aria-label="Results">
        <div className={styles.outputsHead}>
          <h2>Results</h2>
          <span className="mono">{liveCount > 0 ? `${liveCount} in progress` : balance !== null ? `${balance.toLocaleString()} credits` : ''}</span>
        </div>
        {cards.length === 0 ? (
          <EmptyState
            icon={<Icon.library />}
            title="Nothing made yet"
            body="Pick a tool, press the button, and watch it happen here. A failed generation gives the credits straight back."
          />
        ) : (
          <div className={styles.grid}>
            {cards.map((c) => (
              <ResultCard
                key={c.clientKey}
                card={c}
                onUseAsSource={useAsSource}
                onSendToVideo={sendToVideo}
                onAgain={again}
                onEdit={edit}
                onCancel={(k) => void cancel(k)}
                onDismiss={dismiss}
                onRefreshUrls={(k, keys) => void resolveUrls(k, keys)}
                onEditText={(k, f, v) => void editText(k, f, v)}
                onRegenerateField={regenerateField}
                onUnlock={unlock}
                unlockPrice={unlockPrice}
              />
            ))}
          </div>
        )}
      </section>
      <div className={styles.mobileSpacer} />
    </div>
  );
}
