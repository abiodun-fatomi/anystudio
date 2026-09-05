/**
 * Branded product images — the fidelity loop.
 *
 * A seller will post a picture of their product in a better scene. They
 * will not post a picture of a slightly different product. So this is not
 * one call:
 *
 *   1. cut the product out (BACKGROUND_REMOVE) → an alpha mask of what
 *      must not change
 *   2. ask the edit model for the scene, with the product held constant
 *   3. SCORE the product region of the result against the source
 *        ≥ keep       the model kept it; use its output, lighting and all
 *        ≥ composite  close but drifting; paste the ORIGINAL pixels back
 *                     over the scene, with a soft shadow so they sit in it
 *        below        ask once more, sternly; a second miss is LOW_QUALITY
 *                     — refunded, and the customer told why in plain words
 *   4. composite price, business name or logo, watermark — ours, with
 *      sharp, never asked of a model that cannot spell a price
 *   5. cut every export size with an attention crop
 *
 * Every number the loop decides on is logged with the generation, so a
 * refused image can be explained and the thresholds tuned from evidence.
 */

import sharp, { type OverlayOptions } from 'sharp';
import { EXPORT_SIZES, ProviderError, type CapabilityParams, type ProviderArtifact, type ProviderResult } from '@anystudio/shared';
import type { Pipeline, PipelineContext } from './index';
import { FIDELITY, fidelity } from './fidelity';
import { fetchBytes } from '../../modules/provider/adapters/http';

const STRICTER =
  '\n\nIMPORTANT: the product must be reproduced EXACTLY as in the reference photo — identical shape, size, colours, label, text and position in frame. Do not restyle, recolour, rotate or reinterpret it. Only the background and surroundings may change.';

export const brandedImagePipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'IMAGE_EDIT'>;
  const sourceUrl = ctx.files.sourceKey?.url;
  if (!sourceUrl) throw new ProviderError('INVALID_INPUT', 'no source', 'image-pipeline');

  // 1. The mask. If the cutout cannot be made, the loop degrades to a single trusted call rather than failing the customer.
  let source: Uint8Array | null = null;
  let cutout: Uint8Array | null = null;
  if (p.preserveProduct) {
    await ctx.stage('preparing', 8, 'cutting out your product');
    try {
      source = (await fetchBytes('image-pipeline', sourceUrl, 60_000)).bytes;
      const cut = await ctx.callCapability(
        'BACKGROUND_REMOVE',
        { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, params: { sourceKey: p.sourceKey, background: 'transparent' }, files: ctx.files },
        { timeoutMs: 60_000, signal: ctx.signal },
      );
      cutout = await artifactBytes(cut);
    } catch (err) {
      ctx.log.warn({ err: err instanceof Error ? err.message : err }, 'cutout unavailable; skipping the fidelity check for this image');
      cutout = null;
    }
  }

  // 2–3. Ask, measure, decide — at most twice.
  let picked: { bytes: Uint8Array; result: ProviderResult; score?: number; composited: boolean } | null = null;
  for (let attempt = 1; attempt <= 2 && !picked; attempt++) {
    const params = attempt === 1 ? p : { ...p, prompt: p.prompt + STRICTER };
    const result = await ctx.callProvider(
      { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, capability: 'IMAGE_EDIT', params, files: ctx.files },
      { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('generating', progress ?? 40, detail) },
    );
    const bytes = await artifactBytes(result);

    if (!source || !cutout) {
      picked = { bytes, result, composited: false };
      break;
    }

    await ctx.stage('composing', 62, 'checking the product stayed the same');
    const report = await fidelity(source, cutout, bytes);
    ctx.log.info({ attempt, ...report, thresholds: FIDELITY, providerKey: result.providerKey }, 'fidelity measured');

    if (report.score >= FIDELITY.keep) {
      picked = { bytes, result, score: report.score, composited: false };
    } else if (report.score >= FIDELITY.composite) {
      const same = await sameFrame(source, bytes);
      if (same) {
        picked = { bytes: await pasteProduct(bytes, cutout), result, score: report.score, composited: true };
        ctx.log.info({ attempt, score: report.score }, 'product drifted; original pixels composited back over the scene');
      } else {
        picked = { bytes, result, score: report.score, composited: false };
        ctx.log.warn({ attempt, score: report.score }, 'product drifted but the frame changed; shipping the model output');
      }
    } else if (attempt === 1) {
      ctx.log.warn({ attempt, score: report.score }, 'product not kept; asking once more with a stricter prompt');
      await ctx.stage('generating', 30, 'the first try changed your product — trying again');
    } else {
      throw new ProviderError('LOW_QUALITY', `product fidelity ${report.score} below ${FIDELITY.composite} on two attempts`, result.providerKey, {
        providerJobId: result.providerJobId,
        raw: report,
      });
    }
  }
  if (!picked) throw new ProviderError('RETRYABLE', 'no image produced', 'image-pipeline');

  // 4. Our words, our logo, our watermark.
  await ctx.stage('composing', 74, 'adding your name and price');
  const branded = await brand(ctx, picked.bytes, p);

  // 5. Every size.
  await ctx.stage('composing', 84, 'cutting every size');
  const meta = await sharp(branded).metadata();
  const artifacts: ProviderArtifact[] = [{ bytes: new Uint8Array(branded), mime: 'image/png', role: 'image', width: meta.width, height: meta.height }];
  for (const size of p.sizes) {
    const spec = EXPORT_SIZES[size];
    const bytes = await sharp(branded)
      .resize(spec.width, spec.height, { fit: 'cover', position: sharp.strategy.attention })
      .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    artifacts.push({ bytes: new Uint8Array(bytes), mime: 'image/jpeg', role: 'variant', width: spec.width, height: spec.height, size });
  }
  return { artifacts, providerKey: picked.result.providerKey, providerJobId: picked.result.providerJobId, costMinor: picked.result.costMinor };
};

/** The first image artifact's bytes, fetched if the vendor left them at a URL. */
async function artifactBytes(result: ProviderResult): Promise<Uint8Array> {
  const a = result.artifacts.find((x) => x.role === 'image') ?? result.artifacts[0];
  if (!a) throw new ProviderError('RETRYABLE', `${result.providerKey}: returned no image`, result.providerKey);
  if (a.bytes) return a.bytes;
  if (a.url) return (await fetchBytes(result.providerKey, a.url, 60_000)).bytes;
  throw new ProviderError('RETRYABLE', `${result.providerKey}: image had no bytes`, result.providerKey);
}

/** Same aspect within 1.5%: the cutout can be laid back over the output where it was. */
async function sameFrame(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const [ma, mb] = await Promise.all([sharp(a).metadata(), sharp(b).metadata()]);
  if (!ma.width || !ma.height || !mb.width || !mb.height) return false;
  return Math.abs(ma.width / ma.height - mb.width / mb.height) < 0.015;
}

/** The original product pixels over the generated scene, with a soft contact shadow under them. */
export async function pasteProduct(scene: Uint8Array, cutout: Uint8Array): Promise<Uint8Array> {
  const meta = await sharp(scene).metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;
  const product = await sharp(cutout).resize(W, H, { fit: 'fill' }).ensureAlpha().png().toBuffer();
  // Shadow: the mask, blurred and darkened, offset a little down.
  const alpha = await sharp(product)
    .extractChannel(3)
    .blur(Math.max(4, W / 90))
    .raw()
    .toBuffer();
  const shadow = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    shadow[i * 4 + 3] = Math.round((alpha[i] ?? 0) * 0.38);
  }
  const shadowPng = await sharp(shadow, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toBuffer();
  const out = await sharp(scene)
    .composite([
      { input: shadowPng, top: Math.round(H * 0.012), left: 0 },
      { input: product, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
  return new Uint8Array(out);
}

/** Price pill, business name or logo, watermark — from the brand kit, exactly. */
async function brand(ctx: PipelineContext, image: Uint8Array, p: CapabilityParams<'IMAGE_EDIT'>): Promise<Buffer> {
  const kit = ctx.brandKit;
  const showPrice = p.brand?.showPrice ?? kit?.showPrice ?? true;
  const showName = p.brand?.showBusinessName ?? true;
  const watermark = p.brand?.watermark ?? Boolean((kit?.watermark as { enabled?: boolean } | null)?.enabled);
  const businessName = p.businessName ?? kit?.businessName ?? null;
  const palette = (kit?.palette as string[] | null) ?? [];
  const accent = palette[0] && /^#[0-9a-fA-F]{6}$/.test(palette[0]) ? palette[0] : '#D6006E';

  const base = sharp(image);
  const meta = await base.metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;
  const overlays: OverlayOptions[] = [];

  // A logo takes the name's place when the kit has one and the customer did not type a name for this image.
  let logo: Buffer | null = null;
  if (showName && kit?.logoKey && !p.businessName) {
    try {
      const raw = await ctx.media.getBytes(kit.logoKey);
      logo = await sharp(raw)
        .resize(Math.round(W * 0.16), Math.round(H * 0.1), { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
    } catch (err) {
      ctx.log.warn({ err: err instanceof Error ? err.message : err, logoKey: kit.logoKey }, 'brand logo unreadable; falling back to the name');
    }
  }
  const badge = svgBadge({ W, H, accent, price: showPrice ? (p.price ?? null) : null, name: showName && !logo ? businessName : null, watermark });
  if (badge) overlays.push({ input: Buffer.from(badge), top: 0, left: 0 });
  if (logo) {
    const lm = await sharp(logo).metadata();
    overlays.push({ input: logo, left: W - (lm.width ?? 0) - Math.round(W * 0.035), top: H - (lm.height ?? 0) - Math.round(H * 0.035) });
  }
  return base.composite(overlays).png().toBuffer();
}

function svgBadge(o: { W: number; H: number; accent: string; price: string | null; name: string | null; watermark: boolean }): string | null {
  if (!o.price && !o.name && !o.watermark) return null;
  const u = Math.round(Math.min(o.W, o.H) / 40);
  const items: string[] = [];
  if (o.price) {
    const fs = u * 2.2;
    const w = Math.round(o.price.length * fs * 0.62 + u * 3);
    items.push(`<rect x="${u * 1.5}" y="${o.H - u * 1.5 - fs * 1.9}" rx="${u * 0.6}" width="${w}" height="${fs * 1.9}" fill="${o.accent}"/>`);
    items.push(
      `<text x="${u * 3}" y="${o.H - u * 1.5 - fs * 0.55}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#FFFFFF">${esc(o.price)}</text>`,
    );
  }
  if (o.name) {
    const fs = u * 1.5;
    items.push(
      `<text x="${o.W - u * 1.5}" y="${o.H - u * 1.8}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="${fs}" fill="#FFFFFF" stroke="#000000" stroke-opacity="0.35" stroke-width="${fs * 0.08}" paint-order="stroke">${esc(o.name)}</text>`,
    );
  }
  if (o.watermark) {
    const fs = u * 1.1;
    items.push(
      `<text x="${o.W - u * 1.2}" y="${u * 2.2}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="${fs}" fill="#FFFFFF" fill-opacity="0.55">made on studo</text>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.W}" height="${o.H}">${items.join('')}</svg>`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
