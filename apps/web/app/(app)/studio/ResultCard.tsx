'use client';
/**
 * One generation, from "asked" to "here it is". The card is born QUEUED,
 * narrates the worker's stages in the tool's words, shows outputs the
 * moment each lands, and on failure says what happened and that the
 * credits are back. Every result offers the next thing: download at a
 * size, use as the source, send to video, do it again, copy the caption.
 */
import { useEffect, useMemo, useState } from 'react';
import { COPY_FIELDS } from '@anystudio/shared';
import type { GenerationOutputRow } from '@/lib/api';
import { toolById } from '@/lib/studio/tools';
import type { GenerationCard } from '@/lib/studio/useGenerations';
import { Badge, Button, Progress, Skeleton, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './studio.module.css';

const STATUS_TONE: Record<GenerationCard['status'], 'accent' | 'ok' | 'warn' | 'danger' | undefined> = { requesting: 'warn', QUEUED: 'warn', RUNNING: 'accent', SUCCEEDED: 'ok', FAILED: 'danger', CANCELLED: undefined };
const STATUS_LABEL: Record<GenerationCard['status'], string> = { requesting: 'Sending', QUEUED: 'Queued', RUNNING: 'Working', SUCCEEDED: 'Done', FAILED: 'Failed', CANCELLED: 'Cancelled' };

export function ResultCard({ card, onUseAsSource, onSendToVideo, onAgain, onCancel, onDismiss, onRefreshUrls, onEditText, onRegenerateField }: {
  card: GenerationCard;
  onUseAsSource: (key: string) => void;
  onSendToVideo: (key: string) => void;
  onAgain: (card: GenerationCard) => void;
  onCancel: (clientKey: string) => void;
  onDismiss: (clientKey: string) => void;
  onRefreshUrls: (clientKey: string, keys: string[]) => void;
  onEditText: (clientKey: string, field: string, value: string) => void;
  onRegenerateField: (clientKey: string, field: string, instruction: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const tool = toolById(card.toolId);
  const live = card.status === 'requesting' || card.status === 'QUEUED' || card.status === 'RUNNING';
  const main = card.outputs.find((o) => o.role === 'image') ?? card.outputs.find((o) => o.role === 'video');
  const variants = card.outputs.filter((o) => o.role === 'variant');
  const text = card.outputs.find((o) => o.role === 'text')?.text as CopyText | undefined;
  const mainUrl = main ? card.urls[main.key] : undefined;
  const missingUrls = useMemo(() => card.outputs.filter((o) => o.key && !card.urls[o.key]).map((o) => o.key), [card.outputs, card.urls]);
  const narrative = card.detail ?? tool.narrative[card.stage] ?? 'Working';
  const elapsed = useElapsed(card.createdAt, live);

  return (
    <article className={styles.card} data-status={card.status} aria-live={live ? 'polite' : undefined}>
      <div className={styles.cardHead}>
        <div className={styles.cardTitle}>{Icon[tool.icon]({ width: 18, height: 18 })}{tool.label}</div>
        <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center' }}>
          <Badge tone={STATUS_TONE[card.status]} dot={live}>{STATUS_LABEL[card.status]}</Badge>
          <span className={styles.cardMeta}>{card.credits} cr</span>
        </div>
      </div>

      {live && (
        <div className={styles.narrate}>
          <div className={styles.narrateText}><span>{narrative}</span><span>{elapsed}</span></div>
          <Progress value={card.status === 'requesting' ? null : card.progress} />
        </div>
      )}

      {(card.status === 'FAILED' || card.status === 'CANCELLED') && (
        <div className={styles.fail}>
          <strong>{card.status === 'CANCELLED' ? 'Cancelled' : 'That did not work'}</strong>
          <span>{card.message ?? 'Something went wrong. Your credits are back.'}</span>
          {card.id && <span className={styles.refunded}><Icon.check width={14} height={14} /> {card.credits} credits returned</span>}
        </div>
      )}

      {main && (
        <div className={styles.preview}>
          {mainUrl
            ? main.role === 'video'
              ? <video src={mainUrl} controls playsInline preload="metadata" />
              : <img src={mainUrl} alt={`Result from ${tool.label}`} />
            : <Skeleton className={styles.previewSkel} />}
        </div>
      )}
      {live && !main && card.status === 'RUNNING' && card.stage !== 'queued' && <Skeleton className={styles.previewSkel} />}

      {variants.length > 0 && (
        <div className={styles.variants} aria-label="Sizes">
          {variants.map((v) => (
            <a key={v.key} className={styles.variant} href={card.urls[v.key] ?? '#'} download target="_blank" rel="noreferrer" aria-disabled={!card.urls[v.key]}>
              {sizeLabel(v)} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>{v.width}×{v.height}</span>
            </a>
          ))}
        </div>
      )}

      {text && <CopyView text={text} editable={card.status === 'SUCCEEDED' && Boolean(card.id)} onEdit={(f, v) => onEditText(card.clientKey, f, v)} onRegenerate={(f, i) => onRegenerateField(card.clientKey, f, i)} />}

      {!live && missingUrls.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => onRefreshUrls(card.clientKey, missingUrls)}>Refresh previews</Button>
      )}

      <div className={styles.actions}>
        {live && card.status === 'QUEUED' && card.id && <Button variant="ghost" size="sm" onClick={() => onCancel(card.clientKey)}>Cancel</Button>}
        {card.status === 'SUCCEEDED' && main && mainUrl && <Button variant="ghost" size="sm" href={mainUrl} leading={<Icon.publish width={16} height={16} />}>Download</Button>}
        {card.status === 'SUCCEEDED' && main?.role === 'image' && <Button variant="ghost" size="sm" onClick={() => onUseAsSource(main.key)}>Use as source</Button>}
        {card.status === 'SUCCEEDED' && main?.role === 'image' && <Button variant="ghost" size="sm" onClick={() => onSendToVideo(main.key)}>Make a reel from this</Button>}
        {!live && <Button variant="ghost" size="sm" onClick={() => onAgain(card)}>Do it again</Button>}
        {!live && <Button variant="link" size="sm" onClick={() => onDismiss(card.clientKey)} style={{ marginLeft: 'auto' }}>Hide</Button>}
      </div>
    </article>
  );
}

interface CopyText {
  description?: { long?: string; short?: string; bullets?: string[] };
  captions?: Record<string, string>;
  hashtags?: { broad?: string[]; niche?: string[]; local?: string[] };
  altText?: string;
  seo?: { title?: string; metaDescription?: string };
}

function CopyView({ text, editable, onEdit, onRegenerate }: { text: CopyText; editable: boolean; onEdit: (field: string, value: string) => void; onRegenerate: (field: string, instruction: string) => Promise<{ ok: boolean; message?: string }> }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); toast({ title: `${label} copied`, tone: 'ok', durationMs: 2000 }); }
    catch { toast({ title: 'Could not copy', body: 'Select the text and copy it yourself.', tone: 'warn' }); }
  };
  const fields: Array<{ path: string; value: string }> = [];
  const get = (path: string): string | undefined => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), text) as string | undefined;
  for (const path of ['description.long', 'captions.instagram', 'captions.tiktok', 'captions.whatsapp_status', 'captions.facebook', 'captions.x']) { const v = get(path); if (v) fields.push({ path, value: v }); }
  if (text.hashtags) { const all = [...(text.hashtags.broad ?? []), ...(text.hashtags.niche ?? []), ...(text.hashtags.local ?? [])]; if (all.length) fields.push({ path: 'hashtags', value: all.join(' ') }); }
  if (expanded) for (const path of ['description.short', 'altText', 'seo.title', 'seo.metaDescription']) { const v = get(path); if (v) fields.push({ path, value: v }); }
  return (
    <div className={styles.copyBlock}>
      {fields.map((f) => (
        <CopyField key={f.path} path={f.path} value={f.value} editable={editable && Boolean(COPY_FIELDS[f.path])} onCopy={() => void copy(COPY_FIELDS[f.path]?.label ?? 'Hashtags', f.value)} onEdit={(v) => onEdit(f.path, v)} onRegenerate={(i) => onRegenerate(f.path, i)} />
      ))}
      <Button variant="link" size="sm" onClick={() => setExpanded((e) => !e)} style={{ justifySelf: 'start' }}>{expanded ? 'Less' : 'More: short description, alt text, SEO'}</Button>
    </div>
  );
}

/** One field: read, or edit in place with the original shown for comparison, or ask for a rewrite with a note. */
function CopyField({ path, value, editable, onCopy, onEdit, onRegenerate }: { path: string; value: string; editable: boolean; onCopy: () => void; onEdit: (v: string) => void; onRegenerate: (instruction: string) => Promise<{ ok: boolean; message?: string }> }) {
  const { toast } = useToast();
  const spec = COPY_FIELDS[path];
  const label = spec?.label ?? 'Hashtags';
  const [mode, setMode] = useState<'read' | 'edit' | 'ask'>('read');
  const [draft, setDraft] = useState(value);
  const [original] = useState(value);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = value !== original;
  const over = spec ? draft.length > spec.max : false;

  const rewrite = async () => {
    setBusy(true);
    const r = await onRegenerate(note.trim());
    setBusy(false);
    if (r.ok) { setMode('read'); setNote(''); toast({ title: `${label} rewritten`, body: '1 credit.', tone: 'ok', durationMs: 2500 }); }
    else toast({ title: 'Could not rewrite', body: r.message, tone: 'danger' });
  };

  return (
    <div className={styles.copyField}>
      <div className={styles.copyFieldHead}>
        <span>{label}{changed && <em style={{ marginLeft: 8, fontStyle: 'normal', color: 'var(--accent)' }}>· edited</em>}</span>
        <span style={{ display: 'flex', gap: 'var(--s-2)' }}>
          {editable && mode === 'read' && <Button variant="link" size="sm" onClick={() => { setDraft(value); setMode('edit'); }}>Edit</Button>}
          {editable && mode === 'read' && <Button variant="link" size="sm" onClick={() => setMode('ask')}>Rewrite · 1 cr</Button>}
          <Button variant="link" size="sm" onClick={onCopy}>Copy</Button>
        </span>
      </div>
      {mode === 'read' && <div className={styles.copyText}>{value}</div>}
      {mode === 'edit' && (
        <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
          <textarea className={styles.copyText} style={{ font: 'inherit', fontSize: 'var(--t-2)', resize: 'vertical', minHeight: 96, maxHeight: 'none', color: 'var(--ink)' }} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`Edit ${label}`} />
          {changed && <details><summary style={{ fontSize: 'var(--t-1)', color: 'var(--muted)', cursor: 'pointer' }}>What it said before</summary><div className={styles.copyText} style={{ marginTop: 6, color: 'var(--muted)' }}>{original}</div></details>}
          <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center' }}>
            <Button size="sm" onClick={() => { onEdit(draft); setMode('read'); }} disabled={over || !draft.trim()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('read')}>Cancel</Button>
            {spec && <span className="mono" style={{ marginLeft: 'auto', color: over ? 'var(--danger)' : undefined }}>{draft.length} / {spec.max}</span>}
          </div>
        </div>
      )}
      {mode === 'ask' && (
        <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
          <div className={styles.copyText}>{value}</div>
          <input className={styles.copyText} style={{ font: 'inherit', fontSize: 'var(--t-2)', color: 'var(--ink)' }} placeholder="What should change? e.g. shorter, mention the free delivery, less formal" value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} aria-label={`How to rewrite ${label}`} onKeyDown={(e) => { if (e.key === 'Enter') void rewrite(); }} />
          <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
            <Button size="sm" loading={busy} onClick={() => void rewrite()}>Rewrite for 1 credit</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('read')} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

const sizeLabel = (v: GenerationOutputRow) => ({ feed_square: 'Feed 1:1', feed_portrait: 'Feed 4:5', story: 'Story', landscape: 'Landscape', marketplace: 'Marketplace' } as Record<string, string>)[v.size ?? ''] ?? v.size ?? 'Size';

/** "12s" ticking while live, frozen after. Uses a re-render tick only while needed. */
function useElapsed(since: number, live: boolean): string {
  const [, tick] = useState(0);
  useEffect(() => { if (!live) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [live]);
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
