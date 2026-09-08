import sharp from 'sharp';
import { ProviderError } from '@anystudio/shared';
import type { Pipeline } from './index';

/** Wan's first-frame contract: opaque image, 360–2000 px per edge, <=10 MB.
 * Keep the whole product: resize proportionally, padding only very narrow
 * inputs instead of cropping their edges. The original upload is untouched.
 */
export async function prepareVideoFrame(bytes: Buffer): Promise<Buffer> {
  try {
    const resized = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    const horizontal = Math.max(0, 360 - resized.info.width);
    const vertical = Math.max(0, 360 - resized.info.height);
    const output = await sharp(resized.data)
      .extend({
        left: Math.floor(horizontal / 2),
        right: Math.ceil(horizontal / 2),
        top: Math.floor(vertical / 2),
        bottom: Math.ceil(vertical / 2),
        background: '#ffffff',
      })
      .jpeg({ quality: 95 })
      .toBuffer();
    if (output.length > 10 * 1024 * 1024) throw new Error('prepared image exceeds 10 MB');
    return output;
  } catch {
    throw new ProviderError(
      'INVALID_INPUT',
      'This image could not be prepared for video. Upload a JPEG, PNG or WebP photo under 40 megapixels.',
      'video-frame',
    );
  }
}

export const videoShotPipeline: Pipeline = async (ctx) => {
  const source = ctx.files.sourceKey;
  if (!source?.key) throw new ProviderError('INVALID_INPUT', 'A source photo is required for video.', 'video-frame');
  const frame = await prepareVideoFrame(await ctx.media.getBytes(source.key));
  const key = await ctx.media.putGenerationWork({
    workspaceId: ctx.row.workspaceId,
    generationId: ctx.row.id,
    createdAt: ctx.row.createdAt,
    name: 'video-frame.jpg',
    bytes: frame,
    mime: 'image/jpeg',
  });
  const result = await ctx.callProvider(
    {
      generationId: ctx.row.id,
      workspaceId: ctx.row.workspaceId,
      capability: 'IMAGE_TO_VIDEO',
      params: ctx.row.input as Record<string, unknown>,
      files: { ...ctx.files, sourceKey: { key, url: await ctx.media.signRead(key, 60 * 60), mime: 'image/jpeg', bytes: frame.length } },
    },
    { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('generating', progress ?? 40, detail) },
  );
  return { artifacts: result.artifacts, providerKey: result.providerKey, providerJobId: result.providerJobId, costMinor: result.costMinor };
};
