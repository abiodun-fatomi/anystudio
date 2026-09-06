/**
 * Cutting export sizes without losing the product.
 *
 * A story is 9:16 and a landscape scene is 16:9; something has to go. The
 * generic "attention" crop keeps whatever is brightest and busiest, which
 * in a shop photo is the window, not the bottle. So the crop is aimed:
 *
 *   1. by the product mask when we have one — the cutout's alpha says where
 *      the product is, and the model was told to keep it in place;
 *   2. otherwise by sharpness — the product is what the vendor kept in
 *      focus, and blur is what it did to everything else — weighted toward
 *      the middle of the frame.
 *
 * The window is the largest rectangle of the target shape that fits, placed
 * so the focal point sits at its centre and clamped to the frame.
 */
import sharp from 'sharp';

export interface Focal {
  /** 0..1 across the frame. */
  x: number;
  /** 0..1 down the frame. */
  y: number;
  /** Where the point came from, for the log. */
  from: 'match' | 'mask' | 'sharpness' | 'centre';
}

const SMALL = 96;

/** Centre of mass of the cutout's alpha, or null when the mask is empty. */
export async function maskFocal(cutout: Uint8Array | Buffer): Promise<Focal | null> {
  const alpha = await sharp(cutout).resize(SMALL, SMALL, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i]! < 128) continue;
    sx += i % SMALL;
    sy += Math.floor(i / SMALL);
    n++;
  }
  if (n < 16) return null;
  return { x: (sx / n + 0.5) / SMALL, y: (sy / n + 0.5) / SMALL, from: 'mask' };
}

/**
 * Where the detail is: the Laplacian of the luminance, weighted by a soft
 * centre prior so a sharp edge of the frame does not win on its own.
 */
export async function sharpnessFocal(image: Uint8Array | Buffer): Promise<Focal> {
  const grey = await sharp(image).resize(SMALL, SMALL, { fit: 'fill' }).removeAlpha().greyscale().raw().toBuffer();
  // |Laplacian| by hand: the image is 96×96, and libvips clamps a zero-sum kernel to nothing.
  const at = (x: number, y: number) => grey[y * SMALL + x]!;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let py = 1; py < SMALL - 1; py++) {
    for (let px = 1; px < SMALL - 1; px++) {
      const lap = Math.abs(4 * at(px, py) - at(px - 1, py) - at(px + 1, py) - at(px, py - 1) - at(px, py + 1));
      const dx = (px + 0.5) / SMALL - 0.5;
      const dy = (py + 0.5) / SMALL - 0.5;
      const prior = Math.exp(-(dx * dx + dy * dy) / (2 * 0.3 * 0.3));
      const w = lap * prior;
      sx += px * w;
      sy += py * w;
      sw += w;
    }
  }
  if (sw === 0) return { x: 0.5, y: 0.5, from: 'centre' };
  return { x: (sx / sw + 0.5) / SMALL, y: (sy / sw + 0.5) / SMALL, from: 'sharpness' };
}

/** The crop window, in source pixels, for a target shape aimed at a focal point. */
export function window(srcW: number, srcH: number, dstW: number, dstH: number, focal: { x: number; y: number }) {
  const target = dstW / dstH;
  let w = srcW;
  let h = Math.round(srcW / target);
  if (h > srcH) {
    h = srcH;
    w = Math.round(srcH * target);
  }
  const left = Math.min(Math.max(Math.round(focal.x * srcW - w / 2), 0), srcW - w);
  const top = Math.min(Math.max(Math.round(focal.y * srcH - h / 2), 0), srcH - h);
  return { left, top, width: w, height: h };
}

/** Cut one export size out of `image`, aimed at `focal`. */
export async function focalCrop(image: Uint8Array | Buffer, dstW: number, dstH: number, focal: { x: number; y: number }): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const srcW = meta.width ?? dstW;
  const srcH = meta.height ?? dstH;
  const win = window(srcW, srcH, dstW, dstH, focal);
  return sharp(image).extract(win).resize(dstW, dstH, { fit: 'fill' }).jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
}
