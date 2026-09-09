import sharp from 'sharp';
import { EXPORT_SIZES, ProviderError, type CapabilityParams, type ProviderArtifact } from '@anystudio/shared';
import type { Pipeline } from './index';
import { enhancePhoto } from './enhance';

/** Colour-only treatment: no segmentation, generative redraw, or subject crop. */
export const restylePipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'IMAGE_EDIT'>;
  await ctx.stage('preparing', 10, 'Reading the whole photo');
  const source = await ctx.media.getBytes(p.sourceKey);
  let photo = sharp(source, { limitInputPixels: 40_000_000 }).rotate().toColourspace('srgb');
  switch (p.restyle) {
    case 'enhance':
      photo = await enhancePhoto(source);
      break;
    case 'natural':
      photo = photo.modulate({ brightness: 1.04, saturation: 1.03 });
      break;
    case 'warm':
      photo = photo.linear([1.06, 1.02, 0.95], [0, 0, 0]);
      break;
    case 'cool':
      photo = photo.linear([0.96, 1.01, 1.06], [0, 0, 0]);
      break;
    case 'vivid':
      photo = photo.modulate({ brightness: 1.03, saturation: 1.2 });
      break;
    case 'monochrome':
      photo = photo.grayscale();
      break;
    default:
      throw new ProviderError('INVALID_INPUT', 'Choose a supported photo look.', 'local:restyle');
  }
  await ctx.stage('composing', 65, 'Applying the look without changing the scene');
  const { data, info } = await photo.png().toBuffer({ resolveWithObject: true });
  const artifacts: ProviderArtifact[] = [{ bytes: new Uint8Array(data), mime: 'image/png', role: 'image', width: info.width, height: info.height }];
  for (const size of p.sizes) {
    const { width, height } = EXPORT_SIZES[size];
    // Letterbox instead of cropping away a person or objects at the edges.
    const bytes = await sharp(data)
      .resize(width, height, { fit: 'contain', background: '#ffffff' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 95 })
      .toBuffer();
    artifacts.push({ bytes: new Uint8Array(bytes), mime: 'image/jpeg', role: 'variant', width, height, size });
  }
  return { artifacts, providerKey: 'local:restyle', costMinor: 0 };
};
