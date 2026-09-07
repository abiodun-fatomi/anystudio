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
import { EXPORT_SIZES, ProviderError, collageLayoutsFor, type CapabilityParams, type CollageLayout, type ProviderArtifact } from '@anystudio/shared';
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
 * How much of a photo survives being cropped to fill a tile.
 *
 * A 2:3 portrait in a 1.1:1 tile keeps 60% of itself; the rest is thrown
 * away, and if the subject is a face near the middle it is thrown away from
 * the top and bottom. 1 means the shapes match and nothing is lost.
 */
export const kept = (photo: number, cell: number): number => (photo <= 0 || cell <= 0 ? 1 : Math.min(photo, cell) / Math.max(photo, cell));

/**
 * Which layout an `auto` collage becomes.
 *
 * Chosen by measuring, not by counting. The old rule looked only at how many
 * photos there were and whether the frame was tall, and it put two portrait
 * photos in a tall frame ONE ABOVE THE OTHER — which gives each of them a
 * landscape tile and crops 40% off a picture of a child. Now every layout
 * that can hold this many photos is scored on how much of the actual photos
 * it would keep, and the best one wins.
 *
 * `ratios` are the photos' own width/height. With none — a retry before the
 * files are read — it falls back to the old count-and-frame rule.
 */
export function autoLayout(count: number, aspect: string, ratios: number[] = []): Exclude<CollageLayout, 'auto'> {
  const frame = FRAME[aspect] ?? FRAME['1:1']!;
  const candidates = (collageLayoutsFor(count) as CollageLayout[]).filter((l): l is Exclude<CollageLayout, 'auto'> => l !== 'auto' && l !== 'before_after');
  if (candidates.length === 0) return 'grid';
  if (ratios.length === 0) {
    const tall = aspect === '9:16' || aspect === '4:5' || aspect === '3:4';
    if (count === 2) return tall ? 'stack' : 'row';
    if (count === 4 || count === 9) return 'grid';
    if (count === 3) return tall ? 'hero' : 'row';
    return 'hero';
  }
  let best = candidates[0]!;
  let bestScore = -1;
  for (const layout of candidates) {
    const cells = planCells(layout, count, frame.w, frame.h, Math.round(frame.h * 0.014));
    const score = cells.reduce((sum, c, i) => sum + kept(ratios[i] ?? ratios[0]!, c.w / c.h), 0) / cells.length;
    // Ties go to the earlier candidate, which is the tidier arrangement.
    if (score > bestScore + 0.001) {
      bestScore = score;
      best = layout;
    }
  }
  return best;
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
  const background = backgroundOf(p.background, ctx);

  await ctx.stage('preparing', 8, `reading ${p.sourceKeys.length} photos`);

  // READ FIRST, ARRANGE SECOND. The layout depends on the photos' own shapes,
  // so nothing can be planned until they have been measured. A photo that
  // will not open is an empty tile: eight good pictures beat a refund.
  const loaded: Array<{ index: number; bytes: Uint8Array; ratio: number } | null> = [];
  let missing = 0;
  for (let i = 0; i < p.sourceKeys.length; i++) {
    const file = ctx.files[`sourceKeys[${i}]`];
    if (!file) {
      missing++;
      loaded.push(null);
      continue;
    }
    try {
      const { bytes } = await fetchBytes('collage', file.url, 60_000);
      // .rotate() first: a phone photo's real shape is in its EXIF orientation,
      // and measuring before honouring it gets every portrait backwards.
      const upright = await sharp(bytes).rotate().toBuffer();
      const meta = await sharp(upright).metadata();
      loaded.push({ index: i, bytes: new Uint8Array(upright), ratio: (meta.width ?? 1) / (meta.height ?? 1) });
    } catch (err) {
      missing++;
      loaded.push(null);
      ctx.log.warn({ err: err instanceof Error ? err.message : err, index: i }, 'a collage photo could not be read; leaving its tile empty');
    }
  }
  if (loaded.every((l) => l === null)) throw new ProviderError('INVALID_INPUT', 'none of the photos could be read', 'collage');

  const ratios = loaded.filter((l): l is NonNullable<typeof l> => l !== null).map((l) => l.ratio);
  const layout = p.layout === 'auto' ? autoLayout(p.sourceKeys.length, p.aspect, ratios) : p.layout;
  const cells = planCells(layout, p.sourceKeys.length, W, H, gap);
  const radius = p.rounded ? Math.round(Math.min(W, H) * 0.022) : 0;
  const position = p.focus === 'top' ? 'top' : p.focus === 'bottom' ? 'bottom' : p.focus === 'centre' ? 'centre' : sharp.strategy.attention;

  const overlays: OverlayOptions[] = [];
  for (const [i, cell] of cells.entries()) {
    const photo = loaded[i];
    if (!photo) continue;
    // 'fit' keeps the whole picture and lets the ground show around it;
    // 'fill' crops to the tile. Fitting is the default because losing the top
    // of someone's head to a rectangle is not a design decision.
    const tile = await sharp(photo.bytes)
      .resize(cell.w, cell.h, p.fit === 'fill' ? { fit: 'cover', position } : { fit: 'contain', background })
      .toBuffer();
    overlays.push({ input: radius > 0 ? await round(tile, cell.w, cell.h, radius) : tile, left: cell.x, top: cell.y });
    await ctx.stage('composing', 14 + Math.round(((i + 1) / cells.length) * 48), `placing photo ${i + 1} of ${cells.length}`);
  }

  // The words over the photos, if any were typed.
  const captions = labelSvg(cells, p.labels, layout);
  if (captions) overlays.push({ input: Buffer.from(captions), left: 0, top: 0 });

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

  ctx.log.info(
    { layout, chosen: p.layout, fit: p.fit, photos: p.sourceKeys.length, missing, aspect: p.aspect, ratios: ratios.map((r) => Math.round(r * 100) / 100) },
    'collage composed',
  );
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
