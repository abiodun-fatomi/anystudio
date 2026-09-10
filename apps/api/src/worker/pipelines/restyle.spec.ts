import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { parseCapabilityParams } from '@anystudio/shared';
import { brandedImagePipeline } from './image';
import type { PipelineContext } from './index';

describe('photo-preserving Restyle', () => {
  it.each(['natural', 'warm', 'cool', 'vivid', 'monochrome', 'enhance'])('keeps the complete source geometry for %s without calling an AI', async (restyle) => {
    // Four different quadrants, including content at every edge.
    const pixels = Buffer.alloc(80 * 120 * 3);
    for (let y = 0; y < 120; y++)
      for (let x = 0; x < 80; x++) {
        const value = (x < 40 ? 40 : 100) + (y < 60 ? 0 : 80);
        pixels.fill(value, (y * 80 + x) * 3, (y * 80 + x) * 3 + 3);
      }
    const source = await sharp(pixels, { raw: { width: 80, height: 120, channels: 3 } })
      .png()
      .toBuffer();
    const callProvider = vi.fn();
    const callCapability = vi.fn();
    const parsed = parseCapabilityParams('IMAGE_EDIT', { sourceKey: 'ws/source.png', prompt: 'Keep my photo', restyle, sizes: ['feed_square'] });
    if (!parsed.ok) throw new Error('Invalid fixture');
    const ctx = {
      row: { input: parsed.params },
      files: { sourceKey: { url: 'https://example.test/source.png' } },
      media: { getBytes: vi.fn().mockResolvedValue(source) },
      stage: vi.fn(),
      callProvider,
      callCapability,
    } as unknown as PipelineContext;
    const result = await brandedImagePipeline(ctx);
    expect(callProvider).not.toHaveBeenCalled();
    expect(callCapability).not.toHaveBeenCalled();
    expect(result.providerKey).toBe('local:restyle');
    expect(result.artifacts[0]).toMatchObject({ width: 80, height: 120 });
    const output = await sharp(result.artifacts[0]!.bytes!).removeAlpha().toColourspace('srgb').raw().toBuffer();
    const at = (x: number, y: number) => output[(y * 80 + x) * 3]!;
    expect(at(0, 0)).toBeLessThan(at(79, 0));
    expect(at(79, 0)).toBeLessThan(at(0, 119));
    expect(at(0, 119)).toBeLessThan(at(79, 119));
    const variant = await sharp(result.artifacts[1]!.bytes!).raw().toBuffer({ resolveWithObject: true });
    expect(variant.info).toMatchObject({ width: 1080, height: 1080 });
    expect(variant.data[0]).toBeGreaterThan(245); // Border, not a crop.
  });
  it('rejects unsupported looks instead of silently generating another image', () => {
    expect(parseCapabilityParams('IMAGE_EDIT', { sourceKey: 'ws/source.png', prompt: 'Keep my photo', restyle: 'invent-a-scene' }).ok).toBe(false);
  });
});
