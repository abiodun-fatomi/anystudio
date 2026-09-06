/**
 * Did the model keep the product?
 *
 * A generated image where the product changed shape, colour or label is
 * worthless to a seller, and models do it often enough that "looks fine"
 * cannot be assumed. So the pipeline measures the product region of the
 * source (from its cutout mask) against the output, with two signals a
 * changed product cannot hide from — the luminance structure (normalised
 * correlation) and the colour (mean absolute difference in RGB) — blended
 * into one score, 0 to 1.
 *
 * THE PRODUCT MAY HAVE MOVED
 * --------------------------
 * A new scene is often a new frame: a 3:4 phone photo becomes a 16:9
 * banner and the bottle that was centred is now at the left third, a
 * little smaller. Comparing "the same region" of both frames then compares
 * the bottle with a window and refuses a perfect image. So the product is
 * first FOUND in the output — the masked source patch is slid over the
 * output at a handful of scales and the best luminance match wins — and
 * judged where it was found. The location is returned too; the export
 * crops aim at it.
 *
 * It is deliberately not a neural embedding: this has to run on a worker
 * with no GPU, in well under a second, on every image, and be explainable
 * when a seller asks why theirs was refused. The thresholds are exported so
 * they can be tuned against real outputs.
 */

import sharp from 'sharp';

export const FIDELITY = {
  /** At or above: the model kept the product; ship its output untouched. */
  keep: 0.86,
  /** Between: composite the original pixels back over the scene. Below: try again. */
  composite: 0.62,
  /** Structure at or above this means the product was FOUND, even if changed; the original can be pasted where it is. */
  locate: 0.35,
} as const;

export interface FidelityReport {
  score: number;
  structure: number;
  colour: number;
  /** Fraction of the source frame the product covers; a tiny product is hard to judge and easy to lose. */
  coverage: number;
  /** Where the product was found in the output, as fractions of its frame; null when nothing was judged. */
  placed: { x: number; y: number; w: number; h: number; scale: number } | null;
}

/** The output is searched at this many pixels on its long side. */
const SEARCH = 192;
/** The product template is at most this wide/tall inside the search frame at scale 1. */
const SCALES = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.12, 1.25, 1.45, 1.7];
const STRIDE = 3;

interface Patch {
  w: number;
  h: number;
  lum: Float32Array;
  rgb: Uint8Array;
  mask: Uint8Array;
  count: number;
  /** Pixels well inside the mask, where colour is judged. */
  solid: number;
}

/**
 * @param source   the original photo
 * @param cutout   the source with the background removed (RGBA); its alpha is the product mask
 * @param output   what the model produced, any size and any shape
 */
export async function fidelity(source: Buffer | Uint8Array, cutout: Buffer | Uint8Array, output: Buffer | Uint8Array): Promise<FidelityReport> {
  const none: FidelityReport = { score: 0, structure: 0, colour: 0, coverage: 0, placed: null };
  const srcMeta = await sharp(source).metadata();
  const sw = srcMeta.width ?? 0;
  const sh = srcMeta.height ?? 0;
  if (!sw || !sh) return none;

  // 1. The product's box in the source, from the mask.
  const alpha = await sharp(cutout).resize(sw, sh, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
  let minX = sw;
  let minY = sh;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (alpha[y * sw + x]! < 128) continue;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const coverage = area / (sw * sh);
  if (maxX < 0 || area < 64) return { ...none, coverage: round(coverage) };
  const box = { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

  // 2. The output, small, and the template at the size it would have if the frame were unchanged.
  const outMeta = await sharp(output).metadata();
  const ow = outMeta.width ?? 0;
  const oh = outMeta.height ?? 0;
  if (!ow || !oh) return { ...none, coverage: round(coverage) };
  const k = SEARCH / Math.max(ow, oh);
  const OW = Math.max(8, Math.round(ow * k));
  const OH = Math.max(8, Math.round(oh * k));
  const out = await sharp(output).resize(OW, OH, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const outLum = luminance(out, OW * OH);

  // The template keeps the product's own aspect. Its starting size is the
  // frame ratio when the frame is unchanged, the geometric mean of the two
  // ratios when it is not; the scales explore around that.
  const base = Math.sqrt((OW / sw) * (OH / sh));
  const baseW = box.width * base;
  const baseH = box.height * base;

  let best: { ncc: number; x: number; y: number; scale: number; patch: Patch } | null = null;
  for (const scale of SCALES) {
    const tw = Math.round(baseW * scale);
    const th = Math.round(baseH * scale);
    if (tw < 4 || th < 4 || tw > OW || th > OH) continue;
    const patch = await template(source, cutout, box, tw, th);
    if (patch.count < 16) continue;
    for (let y = 0; y + th <= OH; y += STRIDE) {
      for (let x = 0; x + tw <= OW; x += STRIDE) {
        const ncc = correlate(patch, outLum, OW, x, y);
        if (!best || ncc > best.ncc) best = { ncc, x, y, scale, patch };
      }
    }
  }
  if (!best) return { ...none, coverage: round(coverage) };
  // Settle: the coarse pass steps by STRIDE and by ~10 % in scale; finish
  // with finer scales around the winner, each searched pixel by pixel nearby.
  const coarse = best;
  for (const f of [0.92, 0.94, 0.96, 0.98, 1, 1.02, 1.04, 1.06, 1.08]) {
    const scale = coarse.scale * f;
    const tw = Math.round(baseW * scale);
    const th = Math.round(baseH * scale);
    if (tw < 4 || th < 4 || tw > OW || th > OH) continue;
    const patch = f === 1 ? coarse.patch : await template(source, cutout, box, tw, th);
    if (patch.count < 16) continue;
    const cx = coarse.x + (coarse.patch.w - tw) / 2;
    const cy = coarse.y + (coarse.patch.h - th) / 2;
    for (let dy = -STRIDE; dy <= STRIDE; dy++) {
      for (let dx = -STRIDE; dx <= STRIDE; dx++) {
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x + tw > OW || y + th > OH) continue;
        const ncc = correlate(patch, outLum, OW, x, y);
        if (ncc > best.ncc) best = { ncc, x, y, scale, patch };
      }
    }
  }

  // 3. Judge the product where it was found.
  const { patch, x, y } = best;
  let colourDiff = 0;
  for (let j = 0; j < patch.h; j++) {
    for (let i = 0; i < patch.w; i++) {
      const m = j * patch.w + i;
      if (patch.mask[m]! < 240) continue;
      const o = ((y + j) * OW + (x + i)) * 3;
      colourDiff += (Math.abs(patch.rgb[m * 3]! - out[o]!) + Math.abs(patch.rgb[m * 3 + 1]! - out[o + 1]!) + Math.abs(patch.rgb[m * 3 + 2]! - out[o + 2]!)) / 3;
    }
  }
  const structure = Math.max(0, best.ncc);
  // Colour: 0 difference → 1; 60 levels of average difference → 0. Lighting changes cost a little, a recolour costs a lot.
  const colour = Math.max(0, 1 - colourDiff / Math.max(1, patch.solid) / 60);
  const score = 0.65 * structure + 0.35 * colour;
  return {
    score: round(score),
    structure: round(structure),
    colour: round(colour),
    coverage: round(coverage),
    placed: { x: round((x + patch.w / 2) / OW), y: round((y + patch.h / 2) / OH), w: round(patch.w / OW), h: round(patch.h / OH), scale: best.scale },
  };
}

/** The masked product, cut from the source box and resized to tw×th. */
async function template(
  source: Buffer | Uint8Array,
  cutout: Buffer | Uint8Array,
  box: { left: number; top: number; width: number; height: number },
  tw: number,
  th: number,
): Promise<Patch> {
  const srcMeta = await sharp(source).metadata();
  // One resize per sharp pipeline: bring the cutout onto the source frame first, then cut and scale.
  const aligned = await sharp(cutout).resize(srcMeta.width, srcMeta.height, { fit: 'fill' }).ensureAlpha().png().toBuffer();
  const [rgb, mask] = await Promise.all([
    sharp(source).extract(box).resize(tw, th, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    sharp(aligned).extract(box).resize(tw, th, { fit: 'fill' }).extractChannel(3).raw().toBuffer(),
  ]);
  let count = 0;
  let solid = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]! >= 128) count++;
    if (mask[i]! >= 240) solid++;
  }
  return { w: tw, h: th, lum: luminance(rgb, tw * th), rgb: new Uint8Array(rgb), mask: new Uint8Array(mask), count, solid };
}

function luminance(rgb: Buffer, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!;
  return out;
}

/** Normalised cross-correlation of the patch's masked luminance with the output at (x, y). */
function correlate(patch: Patch, outLum: Float32Array, OW: number, x: number, y: number): number {
  let sumA = 0;
  let sumB = 0;
  for (let j = 0; j < patch.h; j++) {
    for (let i = 0; i < patch.w; i++) {
      const m = j * patch.w + i;
      if (patch.mask[m]! < 128) continue;
      sumA += patch.lum[m]!;
      sumB += outLum[(y + j) * OW + (x + i)]!;
    }
  }
  const meanA = sumA / patch.count;
  const meanB = sumB / patch.count;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let j = 0; j < patch.h; j++) {
    for (let i = 0; i < patch.w; i++) {
      const m = j * patch.w + i;
      if (patch.mask[m]! < 128) continue;
      const a = patch.lum[m]! - meanA;
      const b = outLum[(y + j) * OW + (x + i)]! - meanB;
      num += a * b;
      da += a * a;
      db += b * b;
    }
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
