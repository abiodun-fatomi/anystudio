/**
 * Branded product images.
 *
 * The vendor makes the scene. WE put the words on it. An image model will
 * misspell a price or hallucinate a currency symbol often enough that a
 * seller cannot post its output unchecked, so business name, price and the
 * watermark are composited here with sharp, from the brand kit, exactly.
 *
 * Then every requested export size is cut from the composite with an
 * attention crop — sharp finds the region with the most detail, which for a
 * product on a clean scene is the product — so a 9:16 story does not lose
 * the shoes off the bottom of a 1:1 render.
 */

import sharp, { type OverlayOptions } from 'sharp';
import { EXPORT_SIZES, ProviderError, type CapabilityParams, type ProviderArtifact } from '@anystudio/shared';
import type { Pipeline } from './index';

export const brandedImagePipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'IMAGE_EDIT'>;
  const result = await ctx.callProvider(
    { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, capability: 'IMAGE_EDIT', params: p, files: ctx.files },
    { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('generating', progress ?? 40, detail) },
  );
  const first = result.artifacts.find((a) => a.role === 'image');
  if (!first) throw new ProviderError('RETRYABLE', 'edit returned no image', result.providerKey);
  const raw = first.bytes ?? (first.url ? (await fetchImage(first.url)) : undefined);
  if (!raw) throw new ProviderError('RETRYABLE', 'edit image had no bytes', result.providerKey);

  await ctx.stage('composing', 70, 'adding your name and price');
  const brand = ctx.brandKit;
  const showPrice = p.brand?.showPrice ?? brand?.showPrice ?? true;
  const showName = p.brand?.showBusinessName ?? true;
  const watermark = p.brand?.watermark ?? Boolean((brand?.watermark as { enabled?: boolean } | null)?.enabled);
  const businessName = p.businessName ?? brand?.businessName ?? null;
  const palette = (brand?.palette as string[] | null) ?? [];
  const accent = palette[0] && /^#[0-9a-fA-F]{6}$/.test(palette[0]) ? palette[0] : '#D6006E';

  const base = sharp(raw).rotate();
  const meta = await base.metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;
  const overlays: OverlayOptions[] = [];
  const badge = svgBadge({ W, H, accent, price: showPrice ? p.price ?? null : null, name: showName ? businessName : null, watermark });
  if (badge) overlays.push({ input: Buffer.from(badge), top: 0, left: 0 });

  const composed = await base.composite(overlays).png().toBuffer();
  const artifacts: ProviderArtifact[] = [{ bytes: new Uint8Array(composed), mime: 'image/png', role: 'image', width: W, height: H }];

  await ctx.stage('composing', 80, 'cutting every size');
  for (const size of p.sizes) {
    const spec = EXPORT_SIZES[size];
    const bytes = await sharp(composed)
      .resize(spec.width, spec.height, { fit: 'cover', position: sharp.strategy.attention, withoutEnlargement: false })
      .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    artifacts.push({ bytes: new Uint8Array(bytes), mime: 'image/jpeg', role: 'variant', width: spec.width, height: spec.height, size });
  }
  return { artifacts, providerKey: result.providerKey, providerJobId: result.providerJobId, costMinor: result.costMinor };
};

async function fetchImage(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new ProviderError('RETRYABLE', `could not fetch edit output (${res.status})`, 'image-pipeline');
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The overlay: a price pill bottom-left, the business name bottom-right, a
 * faint watermark top-right. All sized from the image so it reads the same
 * at 1024 and 2048. SVG so the text is crisp at any export size.
 */
function svgBadge(o: { W: number; H: number; accent: string; price: string | null; name: string | null; watermark: boolean }): string | null {
  if (!o.price && !o.name && !o.watermark) return null;
  const u = Math.round(Math.min(o.W, o.H) / 40); // one unit ≈ 2.5% of the short side
  const items: string[] = [];
  if (o.price) {
    const fs = u * 2.2;
    const w = Math.round(o.price.length * fs * 0.62 + u * 3);
    items.push(`<rect x="${u * 1.5}" y="${o.H - u * 1.5 - fs * 1.9}" rx="${u * 0.6}" width="${w}" height="${fs * 1.9}" fill="${o.accent}"/>`);
    items.push(`<text x="${u * 1.5 + u * 1.5}" y="${o.H - u * 1.5 - fs * 0.55}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#FFFFFF">${esc(o.price)}</text>`);
  }
  if (o.name) {
    const fs = u * 1.5;
    items.push(`<text x="${o.W - u * 1.5}" y="${o.H - u * 1.8}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="${fs}" fill="#FFFFFF" stroke="#000000" stroke-opacity="0.35" stroke-width="${fs * 0.08}" paint-order="stroke">${esc(o.name)}</text>`);
  }
  if (o.watermark) {
    const fs = u * 1.1;
    items.push(`<text x="${o.W - u * 1.2}" y="${u * 2.2}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="${fs}" fill="#FFFFFF" fill-opacity="0.55">made on studo</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.W}" height="${o.H}">${items.join('')}</svg>`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
