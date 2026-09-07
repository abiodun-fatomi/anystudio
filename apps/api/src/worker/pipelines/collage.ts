/**
 * Several photos in one picture.
 *
 * There is no model here and no vendor: a collage is arithmetic and sharp,
 * on our own box. That is the point — it costs us nothing, it finishes in
 * about a second, and the same photos in the same order always produce the
 * same picture, so "do it again" is not a lottery.
 *
 * The shape of the work:
 *
 *   1. PLAN. The layout and the photo count decide a list of rectangles in
 *      the frame (`planCells`, pure arithmetic, tested on its own).
 *   2. FILL. Each photo is scaled to COVER its rectangle and centre-cropped,
 *      so no cell is ever letterboxed and nothing is squashed. A photo that
 *      cannot be read is left as an empty tile rather than failing the whole
 *      collage — nine photos should not be lost to one bad file.
 *   3. DRESS. Rounded corners, the labels a seller typed over each photo,
 *      then the same price/name/watermark badge a branded image gets, so a
 *      collage and a scene look like they came from one shop.
 *   4. CUT. Every export size the seller asked for.
 */

import sharp, { type OverlayOptions } from 'sharp';
import { EXPORT_SIZES, ProviderError, type CapabilityParams, type CollageLayout, type ProviderArtifact } from '@anystudio/shared';
import type { Pipeline, PipelineContext } from './index';
import { applyBrand } from './image';
import { fetchBytes } from '../../modules/provider/adapters/http';

/** The frame a collage is built at, before the export sizes are cut from it. */
const FRAME: Record<string, { w: number; h: number }> = {
  '1:1': { w: 1440, h: 1440 },
  '4:5': { w: 1296, h: 1620 },
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '3:4': { w: 1296, h: 1728 },
};

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Which layout an `auto` collage becomes. Two photos read best side by side
 * (or stacked, in a tall frame); three want a lead photo; four and nine fall
 * on an even grid; the awkward counts in between are a hero with the rest
 * underneath, which never leaves a hole in the corner.
 */
export function autoLayout(count: number, aspect: string): Exclude<CollageLayout, 'auto'> {
  const tall = aspect === '9:16' || aspect === '4:5' || aspect === '3:4';
  if (count === 2) return tall ? 'stack' : 'row';
  if (count === 4 || count === 9) return 'grid';
  if (count === 3) return tall ? 'hero' : 'row';
  return 'hero';
}

/**
 * The rectangles, in the order the photos were picked. Pure arithmetic: no
 * image is touched here, which is what makes it testable and what makes a
 * layout bug a failing assertion rather than a wrong-looking picture.
 *
 * Every cell is inset by half the gap on each side it shares with a
 * neighbour and by the full gap at the frame's edge, so the border around
 * the collage matches the space inside it.
 */
export function planCells(layout: Exclude<CollageLayout, 'auto'>, count: number, W: number, H: number, gap: number): Cell[] {
  const g = Math.max(0, Math.min(gap, Math.round(Math.min(W, H) / 8)));
  const box = (x: number, y: number, w: number, h: number): Cell => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  const inner = { x: g, y: g, w: W - g * 2, h: H - g * 2 };

  if (layout === 'row' || layout === 'before_after') {
    const w = (inner.w - g * (count - 1)) / count;
    return Array.from({ length: count }, (_, i) => box(inner.x + i * (w + g), inner.y, w, inner.h));
  }
  if (layout === 'stack') {
    const h = (inner.h - g * (count - 1)) / count;
    return Array.from({ length: count }, (_, i) => box(inner.x, inner.y + i * (h + g), inner.w, h));
  }
  if (layout === 'hero') {
    const rest = count - 1;
    // The lead photo takes more of the frame the fewer companions it has,
    // but never so much that the strip below is a sliver.
    const heroShare = rest <= 2 ? 0.62 : rest <= 4 ? 0.58 : 0.54;
    const heroH = (inner.h - g) * heroShare;
    const stripH = inner.h - g - heroH;
    const cells: Cell[] = [box(inner.x, inner.y, inner.w, heroH)];
    // More than four companions read better as two rows than as one thin strip.
    const rows = rest > 4 ? 2 : 1;
    const perRow = Math.ceil(rest / rows);
    const rowH = (stripH - g * (rows - 1)) / rows;
    for (let i = 0; i < rest; i++) {
      const r = Math.floor(i / perRow);
      const inThisRow = Math.min(perRow, rest - r * perRow);
      const c = i - r * perRow;
      const w = (inner.w - g * (inThisRow - 1)) / inThisRow;
      cells.push(box(inner.x + c * (w + g), inner.y + heroH + g + r * (rowH + g), w, rowH));
    }
    return cells;
  }
  // grid: as square as the count allows, with a short last row centred so
  // five photos are 3 + 2 in the middle rather than 3 + 2 pushed left.
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const w = (inner.w - g * (cols - 1)) / cols;
  const h = (inner.h - g * (rows - 1)) / rows;
  const cells: Cell[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inThisRow = Math.min(cols, count - r * cols);
    const offset = ((cols - inThisRow) * (w + g)) / 2;
    cells.push(box(inner.x + offset + c * (w + g), inner.y + r * (h + g), w, h));
  }
  return cells;
}

export const collagePipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'COLLAGE'>;
  const frame = FRAME[p.aspect] ?? FRAME['1:1']!;
  const { w: W, h: H } = frame;
  const gap = Math.round((p.gap / 1000) * Math.min(W, H));
  const layout = p.layout === 'auto' ? autoLayout(p.sourceKeys.length, p.aspect) : p.layout;
  const cells = planCells(layout, p.sourceKeys.length, W, H, gap);
  const radius = p.rounded ? Math.round(Math.min(W, H) * 0.022) : 0;

  await ctx.stage('preparing', 10, `arranging ${p.sourceKeys.length} photos`);

  // The photos, in the order they were picked. A photo that will not open is
  // an empty tile: eight good pictures are worth more than a refund.
  const overlays: OverlayOptions[] = [];
  let missing = 0;
  for (const [i, cell] of cells.entries()) {
    const file = ctx.files[`sourceKeys[${i}]`];
    if (!file) {
      missing++;
      continue;
    }
    try {
      const { bytes } = await fetchBytes('collage', file.url, 60_000);
      const tile = await sharp(bytes)
        .rotate() // honour the phone's EXIF orientation before anything is measured
        .resize(cell.w, cell.h, { fit: 'cover', position: 'attention' })
        .toBuffer();
      overlays.push({ input: radius > 0 ? await round(tile, cell.w, cell.h, radius) : tile, left: cell.x, top: cell.y });
    } catch (err) {
      missing++;
      ctx.log.warn({ err: err instanceof Error ? err.message : err, index: i }, 'a collage photo could not be read; leaving its tile empty');
    }
    await ctx.stage('composing', 12 + Math.round(((i + 1) / cells.length) * 50), `placing photo ${i + 1} of ${cells.length}`);
  }
  if (overlays.length === 0) throw new ProviderError('INVALID_INPUT', 'none of the photos could be read', 'collage');

  // The words over the photos, if any were typed.
  const captions = labelSvg(cells, p.labels, layout);
  if (captions) overlays.push({ input: Buffer.from(captions), left: 0, top: 0 });

  const background = backgroundOf(p.background, ctx);
  const sheet = await sharp({ create: { width: W, height: H, channels: 4, background } })
    .composite(overlays)
    .png()
    .toBuffer();

  await ctx.stage('composing', 74, 'adding your name and price');
  const branded = await applyBrand(ctx, new Uint8Array(sheet), { price: p.price, businessName: p.businessName, brand: p.brand });

  await ctx.stage('composing', 86, 'cutting every size');
  const artifacts: ProviderArtifact[] = [{ bytes: new Uint8Array(branded), mime: 'image/png', role: 'image', width: W, height: H }];
  for (const size of p.sizes) {
    const spec = EXPORT_SIZES[size];
    // A collage is composed edge to edge: a focal crop would cut a photo out
    // of it, so every size is the whole sheet fitted onto the background.
    const bytes = await sharp(branded).resize(spec.width, spec.height, { fit: 'contain', background }).jpeg({ quality: 90 }).toBuffer();
    artifacts.push({ bytes: new Uint8Array(bytes), mime: 'image/jpeg', role: 'variant', width: spec.width, height: spec.height, size });
  }

  ctx.log.info({ layout, photos: p.sourceKeys.length, missing, aspect: p.aspect, sizes: p.sizes.length }, 'collage composed');
  return { artifacts, providerKey: 'local:sharp', costMinor: 0 };
};

/** The colour behind the photos: what was asked for, or the brand kit's first colour. */
function backgroundOf(want: string, ctx: PipelineContext): string {
  if (want !== 'brand') return want;
  const palette = (ctx.brandKit?.palette as string[] | null) ?? [];
  const first = palette.find((c) => /^#[0-9a-fA-F]{6}$/.test(c));
  return first ?? '#FFFFFF';
}

/** A tile with its corners taken off, so the collage reads as cards and not as a contact sheet. */
async function round(tile: Buffer, w: number, h: number, r: number): Promise<Buffer> {
  const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
  return sharp(tile)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/**
 * A word over each photo. Drawn on a dark strip along the bottom of its own
 * cell rather than free on the picture, because a white word over a white
 * bag is not a word at all.
 */
function labelSvg(cells: Cell[], labels: string[], layout: Exclude<CollageLayout, 'auto'>): string | null {
  const wanted = cells.map((cell, i) => ({ cell, text: (labels[i] ?? '').trim() })).filter((x) => x.text.length > 0);
  if (wanted.length === 0) return null;
  const W = Math.max(...cells.map((c) => c.x + c.w));
  const H = Math.max(...cells.map((c) => c.y + c.h));
  const parts: string[] = [];
  for (const { cell, text } of wanted) {
    // Sized against the cell, not the frame: a word in the small strip of a
    // hero layout must not be the size of the one on the lead photo.
    const fs = Math.max(16, Math.round(Math.min(cell.w, cell.h) * (layout === 'before_after' ? 0.09 : 0.11)));
    const padY = Math.round(fs * 0.5);
    const stripH = fs + padY * 2;
    parts.push(
      `<rect x="${cell.x}" y="${cell.y + cell.h - stripH}" width="${cell.w}" height="${stripH}" fill="#000000" fill-opacity="0.46"/>`,
      `<text x="${cell.x + cell.w / 2}" y="${cell.y + cell.h - padY - fs * 0.16}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="${fs}" fill="#FFFFFF">${esc(text)}</text>`,
    );
  }
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
