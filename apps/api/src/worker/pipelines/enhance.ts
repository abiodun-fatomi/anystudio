import sharp, { type Sharp } from 'sharp';

/** Bounded, non-generative exposure/impulse-noise correction. No invented detail. */
export async function enhancePhoto(source: Uint8Array): Promise<Sharp> {
  const photo = sharp(source, { limitInputPixels: 40_000_000 }).rotate().toColourspace('srgb');
  // Analysis is bounded independently of upload dimensions. Ignore transparent
  // pixels so a cutout's invisible background cannot drive exposure correction.
  const { data, info } = await photo
    .clone()
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const histogram = new Uint32Array(256);
  const luma = new Float32Array(info.width * info.height);
  let count = 0;
  for (let i = 0; i < luma.length; i++) {
    const offset = i * 4;
    const value = Math.round(0.2126 * data[offset]! + 0.7152 * data[offset + 1]! + 0.0722 * data[offset + 2]!);
    luma[i] = value;
    if (data[offset + 3]! >= 240) {
      histogram[value]!++;
      count++;
    }
  }
  let mid = 0,
    cumulative = 0;
  for (; mid < 255; mid++) {
    cumulative += histogram[mid]!;
    if (cumulative >= count * 0.6) break;
  }
  // A tone curve lifts shadows without multiplying highlights into clipping.
  // Bounds deliberately avoid turning night shots into daylight, or crushing
  // white catalogue backgrounds. Blank/transparent images need no adjustment.
  if (count > 0 && mid > 3 && mid < 100) {
    const gamma = Math.min(1.6, Math.log(mid / 255) / Math.log(110 / 255));
    photo.gamma(1, gamma);
  } else if (count > 0 && mid > 190 && mid < 250) {
    const gamma = Math.min(1.25, Math.log(185 / 255) / Math.log(mid / 255));
    photo.gamma(gamma, 1);
  }
  // Only classify impulse noise in locally flat regions. Natural texture/edges
  // do not justify a median filter; blindly smoothing would erase small text.
  let flat = 0,
    impulses = 0;
  for (let y = 1; y < info.height - 1; y++)
    for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x;
      const indices = [i, i - 1, i + 1, i - info.width, i + info.width];
      if (indices.some((j) => data[j * 4 + 3]! < 240)) continue;
      const neighbours = indices.slice(1).map((j) => luma[j]!);
      if (Math.max(...neighbours) - Math.min(...neighbours) > 8) continue;
      flat++;
      if (Math.abs(luma[i]! - neighbours.reduce((a, b) => a + b, 0) / 4) > 20) impulses++;
    }
  const noisy = flat > 500 && impulses / flat > 0.08;
  if (noisy) photo.median(3);
  // Avoid sharpening detected noise. Severe blur/compression is not recoverable
  // here and must not be presented as AI restoration.
  else photo.sharpen({ sigma: 0.5, m1: 0.2, m2: 0.6 });
  return photo;
}
