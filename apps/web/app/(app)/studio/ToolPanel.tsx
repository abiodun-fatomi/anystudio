'use client';
/**
 * The tool's controls, the quote, and the one button.
 *
 * The quote is shown before anything is committed: what it costs, what the
 * balance will be after. Out of credits is a conversion moment, not an
 * error — the panel says what this would cost and offers the two ways to
 * fix it, and the button stays visible but disabled so the intent is kept.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type Genre, type Quote, type Voice } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { PLATFORM_OPTIONS, SIZE_OPTIONS, type Field, type Tool } from '@/lib/studio/tools';
import { Button, Combobox, Input, SegmentedControl, Select, Slider, Switch, Textarea } from '@/components/ui';
import styles from './studio.module.css';

export function ToolPanel({ tool, values, onChange, hasSource, onGenerate, busy }: {
  tool: Tool; values: Record<string, unknown>; onChange: (key: string, value: unknown) => void; hasSource: boolean; onGenerate: (quote: Quote) => void; busy: boolean;
}) {
  const { workspace, balance } = useApp();
  const [quote, setQuote] = useState<Quote | null>(null);
  const costCode = tool.costCodeFor?.(values);
  useEffect(() => {
    let live = true;
    setQuote(null);
    api.generations.quote(workspace.id, tool.capability, costCode).then((q) => { if (live) setQuote(q); }).catch(() => undefined);
    return () => { live = false; };
  }, [workspace.id, tool.capability, costCode]);

  const credits = quote?.credits ?? null;
  const after = credits !== null && balance !== null ? balance - credits : null;
  const short = after !== null && after < 0;
  const missingRequired = tool.fields.some((f) => (f.kind === 'text' && f.required && !String(values[f.key] ?? '').trim()) || (f.kind === 'catalogue' && !String(values[f.key] ?? '').trim()));
  const blocked = busy || !quote || short || (tool.needsSource && !hasSource) || missingRequired;
  const why = !hasSource && tool.needsSource ? 'Add a photo first.' : missingRequired ? 'Fill in the required field.' : short ? 'Not enough credits.' : null;

  return (
    <section className={`${styles.pane}`} aria-label={`${tool.label} settings`}>
      <div className={styles.paneBody}>
        <div className={styles.panel}>
          <div>
            <div className={styles.panelTitle}>{tool.label}</div>
            <div className={styles.panelLede}>{quote ? `${quote.label} · ${quote.credits} credits · about ${Math.round(quote.expectedMs / 1000)}s` : ' '}</div>
          </div>

          <div className={styles.fields}>
            {tool.fields.map((f) => <FieldControl key={f.key} field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} />)}
          </div>

          <div className={styles.quote} data-short={short || undefined} aria-live="polite">
            <div className={styles.quoteRow}><span>This will cost</span><strong>{credits ?? '—'} credits</strong></div>
            <div className={styles.quoteRow}><span>Balance after</span><strong>{after === null ? '—' : after.toLocaleString()}</strong></div>
            {short && <div className={styles.quoteNote}>You need {(-after!).toLocaleString()} more. <a href="/billing/plans">Top up</a> or <a href="/billing">see your plan</a>.</div>}
            {!short && <div className={styles.quoteNote}>If it fails, the credits come straight back.</div>}
          </div>

          <div className={styles.generate}>
            <Button full size="lg" loading={busy} disabled={blocked} onClick={() => quote && onGenerate(quote)} title={why ?? undefined}>
              {tool.id === 'copy' ? 'Write it' : tool.id === 'video' ? (Number(values.shots) > 1 ? 'Make the ad' : 'Make the reel') : tool.id === 'music' ? 'Make the song' : tool.id === 'voice' ? 'Record it' : 'Make it'}
            </Button>
            {why && <p className={styles.quoteNote} style={{ marginTop: 'var(--s-2)', textAlign: 'center' }}>{why}</p>}
          </div>
        </div>
      </div>

      {/* Phone: the cost and the button stay in thumb reach. */}
      <div className={styles.generateBar}>
        <span className={styles.quoteInline}>{credits ?? '—'} credits · {after === null ? '—' : after.toLocaleString()} after</span>
        <Button loading={busy} disabled={blocked} onClick={() => quote && onGenerate(quote)}>{tool.id === 'copy' ? 'Write it' : tool.id === 'music' ? 'Make the song' : tool.id === 'voice' ? 'Record it' : 'Make it'}</Button>
      </div>
    </section>
  );
}

/** Genres and voices come from the server; the first option is chosen when nothing is. */
const catalogueCache: { genres?: Promise<Genre[]>; voices?: Promise<Voice[]> } = {};
function CatalogueField({ field, value, onChange }: { field: Extract<Field, { kind: 'catalogue' }>; value: string; onChange: (v: unknown) => void }) {
  const [genres, setGenres] = useState<Genre[] | null>(null);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  useEffect(() => {
    let live = true;
    if (field.source === 'genres') { catalogueCache.genres ??= api.audio.genres(); catalogueCache.genres.then((g) => { if (live) setGenres(g); }).catch(() => { if (live) setGenres([]); }); }
    else { catalogueCache.voices ??= api.audio.voices(); catalogueCache.voices.then((v) => { if (live) setVoices(v); }).catch(() => { if (live) setVoices([]); }); }
    return () => { live = false; };
  }, [field.source]);
  const options = useMemo(() => field.source === 'genres'
    ? (genres ?? []).map((g) => ({ value: g.key, label: g.name, sub: `${g.region} · ${g.description}`, keywords: `${g.family} ${g.region} ${g.languages.join(' ')}` }))
    : (voices ?? []).map((v) => ({ value: v.key, label: v.name, sub: [v.accent ? `${v.accent} ${v.language.startsWith('en') ? 'English' : v.language}` : v.language, v.gender, ...v.tags].filter(Boolean).join(' · '), keywords: `${v.language} ${v.accent ?? ''} ${v.gender ?? ''} ${v.tags.join(' ')} ${v.provider}` })), [field.source, genres, voices]);
  useEffect(() => { if (!value && options[0]) onChange(options[0].value); }, [value, options, onChange]);
  const loaded = field.source === 'genres' ? genres !== null : voices !== null;
  if (loaded && options.length === 0) return <Input label={field.label} value="" readOnly hint={field.source === 'voices' ? 'No voice vendor is configured in this environment yet.' : 'The catalogue is empty.'} />;
  return <Combobox label={field.label} hint={field.hint} options={options} value={value} onChange={onChange} placeholder={loaded ? 'Search…' : 'Loading…'} emptyText="Nothing matches — try a region or a word like 'church' or 'club'" />;
}

function FieldControl({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  switch (field.kind) {
    case 'text':
      return field.rows
        ? <Textarea label={field.label} placeholder={field.placeholder} hint={field.hint} rows={field.rows} maxLength={field.maxLength} showCount={Boolean(field.maxLength && field.maxLength > 100)} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} optional={!field.required} />
        : <Input label={field.label} placeholder={field.placeholder} hint={field.hint} maxLength={field.maxLength} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} optional={!field.required} />;
    case 'segment':
      return (
        <div>
          <span className={styles.fieldLabel}>{field.label}</span>
          <SegmentedControl label={field.label} value={String(value ?? field.options[0]!.id)} onChange={onChange} items={field.options} />
        </div>
      );
    case 'select':
      return <Select label={field.label} options={field.options} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'switch':
      return <Switch label={field.label} hint={field.hint} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
    case 'slider':
      return <Slider label={field.label} min={field.min} max={field.max} step={field.step} value={Number(value ?? field.min)} onChange={onChange} format={field.format} />;
    case 'catalogue':
      return <CatalogueField field={field} value={String(value ?? '')} onChange={onChange} />;
    case 'sizes': {
      const chosen = new Set((value as string[] | undefined) ?? []);
      return (
        <div>
          <span className={styles.fieldLabel}>{field.label}</span>
          <div className={styles.chips} role="group" aria-label={field.label}>
            {SIZE_OPTIONS.map((s) => (
              <button key={s.id} type="button" className={styles.chip} aria-pressed={chosen.has(s.id)} onClick={() => { const n = new Set(chosen); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); onChange([...n]); }} title={s.label}>{s.short}</button>
            ))}
          </div>
        </div>
      );
    }
    case 'platforms': {
      const chosen = new Set((value as string[] | undefined) ?? []);
      return (
        <div>
          <span className={styles.fieldLabel}>{field.label}</span>
          <div className={styles.chips} role="group" aria-label={field.label}>
            {PLATFORM_OPTIONS.map((p) => (
              <button key={p.id} type="button" className={styles.chip} aria-pressed={chosen.has(p.id)} onClick={() => { const n = new Set(chosen); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); onChange([...n]); }}>{p.label}</button>
            ))}
          </div>
        </div>
      );
    }
  }
}
