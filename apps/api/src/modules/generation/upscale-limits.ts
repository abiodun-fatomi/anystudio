import { ValidationError } from '../../../config/globals/errors';

// Clarity reports its 32 MP ceiling in units of 1024² pixels.
export const CLARITY_MAX_OUTPUT_PIXELS = 32 * 1024 * 1024;

export function validateUpscaleSize(width: number, height: number, factor: number): void {
  if (![width, height, factor].every((v) => Number.isFinite(v) && v > 0))
    throw new ValidationError({ sourceKey: 'Could not verify this image’s dimensions. Upload the image again.' });
  const pixels = width * height * factor * factor;
  if (pixels > CLARITY_MAX_OUTPUT_PIXELS) {
    const message = `${width} × ${height} at ${factor}× would create ${width * factor} × ${height * factor} pixels, above Enhance’s 32 MP limit. Choose a smaller factor or upload a smaller image. Your credits have not been charged.`;
    throw new ValidationError({ factor: message }, message);
  }
}
