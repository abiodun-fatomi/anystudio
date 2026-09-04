/**
 * Did the model keep the product?
 *
 * A generated image where the product changed shape, colour or label is
 * worthless to a seller, and models do it often enough that "looks fine"
 * cannot be assumed. So the pipeline measures: the product region of the
 * source (from its cutout mask) against the same region of the output,
 * on a small grey frame, with two signals a changed product cannot hide
 * from — the luminance structure (normalised correlation) and the colour
 * (mean absolute difference in RGB). Blended into one score, 0 to 1.
 *
 * It is deliberately not a neural embedding: this has to run on a worker
 * with no GPU, in milliseconds, on every image, and be explainable when a
 * seller asks why theirs was refused. The thresholds are exported so they
 * can be tuned against real outputs — the number that matters is where
 * real merchants stop noticing, and that is measured, not guessed.
 */

import sharp from 'sharp';

/** Compare on this many pixels per side. Enough for shape and label; cheap. */
const FRAME = 256;

export const FIDELITY = {
  /** At or above: the model kept the product; ship its output untouched. */
  keep: 0.86,
  /** Between: composite the original pixels back over the scene. Below: try again. */
  composite: 0.62,
} as const;

export interface FidelityReport {
  score: number;
  structure: number;
  colour: number;
  /** Fraction of the frame the product covers; a tiny product is hard to judge and easy to lose. */
  coverage: number;
}

/**
 * @param source   the original photo
 * @param cutout   the source with the background removed (RGBA); its alpha is the product mask
 * @param output   what the model produced, any size — resized onto the source frame for the comparison
 */
export async function fidelity(source: Buffer | Uint8Array, cutout: Buffer | Uint8Array, output: Buffer | Uint8Array): Promise<FidelityReport> {
  const [src, out, mask] = await Promise.all([
    sharp(source).resize(FRAME, FRAME, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    sharp(output).resize(FRAME, FRAME, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    sharp(cutout).resize(FRAME, FRAME, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer(),
  ]);

  const n = FRAME * FRAME;
  let count = 0;
  let sumA = 0; let sumB = 0;
  const la = new Float32Array(n); const lb = new Float32Array(n);
  let colourDiff = 0;

  for (let i = 0; i < n; i++) {
    if ((mask[i] ?? 0) < 128) continue;
    const r1 = src[i * 3]!, g1 = src[i * 3 + 1]!, b1 = src[i * 3 + 2]!;
    const r2 = out[i * 3]!, g2 = out[i * 3 + 1]!, b2 = out[i * 3 + 2]!;
    la[i] = 0.299 * r1 + 0.587 * g1 + 0.114 * b1;
    lb[i] = 0.299 * r2 + 0.587 * g2 + 0.114 * b2;
    sumA += la[i]!; sumB += lb[i]!;
    colourDiff += (Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2)) / 3;
    count++;
  }
  const coverage = count / n;
  if (count < 64) return { score: 0, structure: 0, colour: 0, coverage };

  // Normalised cross-correlation of luminance inside the mask: 1 = same structure, 0 = unrelated.
  const meanA = sumA / count; const meanB = sumB / count;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) {
    if ((mask[i] ?? 0) < 128) continue;
    const a = la[i]! - meanA; const b = lb[i]! - meanB;
    num += a * b; da += a * a; db += b * b;
  }
  const structure = da > 0 && db > 0 ? Math.max(0, num / Math.sqrt(da * db)) : 0;
  // Colour: 0 difference → 1; 60 levels of average difference → 0. Lighting changes cost a little, a recolour costs a lot.
  const colour = Math.max(0, 1 - colourDiff / count / 60);

  const score = 0.65 * structure + 0.35 * colour;
  return { score: round(score), structure: round(structure), colour: round(colour), coverage: round(coverage) };
}

const round = (v: number) => Math.round(v * 1000) / 1000;
