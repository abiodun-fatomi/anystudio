'use client';
/**
 * One generation, from "asked" to "here it is". The card is born QUEUED,
 * narrates the worker's stages in the tool's words, shows outputs the
 * moment each lands, and on failure says what happened and that the
 * credits are back. Every result offers the next thing: download at a
 * size, use as the source, send to video, do it again, copy the caption.
 */
import { useEffect, useMemo, useState } from 'react';
import type { GenerationOutputRow } from '@/lib/api';
import { toolById } from '@/lib/studio/tools';
import type { GenerationCard } from '@/lib/studio/useGenerations';
import { Badge, Button, Progress, Skeleton, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './studio.module.css';

const STATUS_TONE: Record<GenerationCard['status'], 'accent' | 'ok' | 'warn' | 'danger' | undefined> = { requesting: 'warn', QUEUED: 'warn', RUNNING: 'accent', SUCCEEDED: 'ok', FAILED: 'danger', CANCELLED: undefined };
const STATUS_LABEL: Record<GenerationCard['status'], string> = { requesting: 'Sending', QUEUED: 'Queued', RUNNING: 'Working', SUCCEEDED: 'Done', FAILED: 'Failed', CANCELLED: 'Cancelled' };

export function ResultCard({ card, onUseAsSource, onSendToVideo, onAgain, onCancel, onDismiss, onRefreshUrls }: {
  card: GenerationCard;
  onUseAsSource: (key: string) => void;
  onSendToVideo: (key: string) => void;
  onAgain: (card: GenerationCard) => void;
  onCancel: (clientKey: string) => void;
  onDismiss: (clientKey: string) => void;
  onRefreshUrls: (clientKey: string, keys: string[]) => void;
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

      {text && <CopyView text={text} />}

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

function CopyView({ text }: { text: CopyText }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); toast({ title: `${label} copied`, tone: 'ok', durationMs: 2000 }); }
    catch { toast({ title: 'Could not copy', body: 'Select the text and copy it yourself.', tone: 'warn' }); }
  };
  const fields: Array<[string, string]> = [];
  if (text.description?.long) fields.push(['Description', text.description.long]);
  for (const [platform, caption] of Object.entries(text.captions ?? {})) fields.push([platformLabel(platform), caption]);
  if (text.hashtags) { const all = [...(text.hashtags.broad ?? []), ...(text.hashtags.niche ?? []), ...(text.hashtags.local ?? [])]; if (all.length) fields.push(['Hashtags', all.join(' ')]); }
  if (expanded && text.description?.short) fields.push(['Short description', text.description.short]);
  if (expanded && text.altText) fields.push(['Alt text', text.altText]);
  if (expanded && text.seo?.title) fields.push(['SEO title', text.seo.title]);
  if (expanded && text.seo?.metaDescription) fields.push(['Meta description', text.seo.metaDescription]);
  return (
    <div className={styles.copyBlock}>
      {fields.map(([label, value]) => (
        <div key={label} className={styles.copyField}>
          <div className={styles.copyFieldHead}><span>{label}</span><Button variant="link" size="sm" onClick={() => void copy(label, value)}>Copy</Button></div>
          <div className={styles.copyText}>{value}</div>
        </div>
      ))}
      <Button variant="link" size="sm" onClick={() => setExpanded((e) => !e)} style={{ justifySelf: 'start' }}>{expanded ? 'Less' : 'More: short description, alt text, SEO'}</Button>
    </div>
  );
}

const platformLabel = (p: string) => ({ instagram: 'Instagram', tiktok: 'TikTok', whatsapp_status: 'WhatsApp Status', facebook: 'Facebook', x: 'X' } as Record<string, string>)[p] ?? p;
const sizeLabel = (v: GenerationOutputRow) => ({ feed_square: 'Feed 1:1', feed_portrait: 'Feed 4:5', story: 'Story', landscape: 'Landscape', marketplace: 'Marketplace' } as Record<string, string>)[v.size ?? ''] ?? v.size ?? 'Size';

/** "12s" ticking while live, frozen after. Uses a re-render tick only while needed. */
function useElapsed(since: number, live: boolean): string {
  const [, tick] = useState(0);
  useEffect(() => { if (!live) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [live]);
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
