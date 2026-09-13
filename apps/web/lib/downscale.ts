/**
 * Shrink a camera photo before it goes up the wire.
 *
 * A 2026 Android camera writes 3–8MB JPEGs at 4000px on the long edge. Every
 * provider we route to works at 1024–2048, so those extra pixels are thrown
 * away the moment they arrive — after the seller has paid for them. On
 * Nigerian prepaid data that is real money, and on a slow uplink it is the
 * difference between a wait and an abandonment.
 *
 * So: decode, draw at a bounded size, re-encode. Everything about this
 * function is defensive, because it sits in front of the one action the whole
 * product depends on. It NEVER throws and it never returns something worse
 * than what it was given — on any doubt at all it hands back the original
 * file, and the upload proceeds exactly as it did before.
 */

/** What the models actually consume. Above this, detail is discarded downstream. */
const MAX_EDGE = 2048;

/**
 * Below this there is nothing to win: the decode-and-re-encode costs a second
 * of a cheap phone's CPU to save a few dozen KB, and risks a generational
 * quality loss for no reason.
 */
const FLOOR_BYTES = 600 * 1024;

/**
 * Formats where re-encoding would destroy the point of the upload.
 * PNG is how a seller sends a cut-out they already has an alpha channel on;
 * flattening it to JPEG would fill the transparency with black.
 */
const RE_ENCODABLE = new Set(['image/jpeg', 'image/jpg', 'image/webp']);

/**
 * A shrink has to actually be worth it. If we only saved a tenth, the
 * original is the safer artifact to send — it is the bytes the seller's phone
 * produced, with whatever the camera knew baked in.
 */
const MIN_SAVING = 0.25;

export interface Downscaled {
  file: File;
  /** Bytes before, for the caller that wants to say what it saved. */
  originalBytes: number;
  /** False when the original was handed straight back, for any reason. */
  shrunk: boolean;
}

export async function downscaleImage(file: File): Promise<Downscaled> {
  const keep: Downscaled = { file, originalBytes: file.size, shrunk: false };
  const type = (file.type || '').split(';')[0]!.trim().toLowerCase();

  if (!RE_ENCODABLE.has(type) || file.size <= FLOOR_BYTES) return keep;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return keep;

  let bitmap: ImageBitmap | undefined;
  try {
    // A HEIC or a truncated file lands here rather than in a broken upload.
    bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= MAX_EDGE) return keep;

    const scale = MAX_EDGE / longest;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return keep;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);

    // Re-encode to the format it arrived as, so a WebP upload stays WebP and
    // the extension on the filename keeps telling the truth.
    const out = type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, out, 0.85));
    // A tainted or oversized canvas resolves null rather than throwing.
    if (!blob || blob.size >= file.size * (1 - MIN_SAVING)) return keep;

    return {
      file: new File([blob], renameFor(file.name, out), { type: out, lastModified: file.lastModified }),
      originalBytes: file.size,
      shrunk: true,
    };
  } catch {
    // Decode failure, out of memory on a cheap phone, a canvas the browser
    // refuses to read back — every one of these means "send the original".
    return keep;
  } finally {
    bitmap?.close?.();
  }
}

/** A file that went in as .heic-named-jpg should not come out claiming to be one. */
function renameFor(name: string, mime: string): string {
  const ext = mime === 'image/webp' ? 'webp' : 'jpg';
  const stem = name.replace(/\.[^./\\]+$/, '') || 'photo';
  return `${stem}.${ext}`;
}
