import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { prepareVideoFrame, videoShotPipeline } from './video-shot';

describe('video first-frame preparation', () => {
  it('passes the prepared file to the provider without overwriting the source input', async () => {
    const source = await sharp({ create: { width: 400, height: 600, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const input = { sourceKey: 'ws/original.png', durationSec: 8 };
    const callProvider = vi.fn(async () => ({ artifacts: [], providerKey: 'fal:wan-2.5-i2v' }));
    const putGenerationWork = vi.fn(async () => 'ws/gen/work/video-frame.jpg');
    await videoShotPipeline({
      row: { id: 'gen', workspaceId: 'ws', createdAt: new Date(), input },
      files: { sourceKey: { key: input.sourceKey } },
      media: { getBytes: vi.fn(async () => source), putGenerationWork, signRead: vi.fn(async () => 'https://storage/prepared.jpg') },
      callProvider,
      budgetMs: 10000,
      signal: new AbortController().signal,
    } as never);
    expect(callProvider).toHaveBeenCalledWith(
      expect.objectContaining({ files: { sourceKey: expect.objectContaining({ key: 'ws/gen/work/video-frame.jpg', mime: 'image/jpeg' }) } }),
      expect.anything(),
    );
    expect(input.sourceKey).toBe('ws/original.png');
    expect(putGenerationWork).toHaveBeenCalledOnce();
  });
  it.each([
    [3000, 4000],
    [80, 800],
    [800, 80],
    [200, 200],
  ])('fits a %ix%i transparent source without losing its edges', async (width, height) => {
    const source = await sharp({ create: { width, height, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 0.5 } } })
      .png()
      .toBuffer();
    const result = await prepareVideoFrame(source);
    const info = await sharp(result).metadata();
    expect(info.format).toBe('jpeg');
    expect(info.hasAlpha).toBe(false);
    expect(info.width).toBeGreaterThanOrEqual(360);
    expect(info.height).toBeGreaterThanOrEqual(360);
    expect(info.width).toBeLessThanOrEqual(2000);
    expect(info.height).toBeLessThanOrEqual(2000);
    expect(result.length).toBeLessThanOrEqual(10 * 1024 * 1024);
  });
  it('rejects an unreadable source before contacting a paid provider', async () => {
    await expect(prepareVideoFrame(Buffer.from('not an image'))).rejects.toMatchObject({ kind: 'INVALID_INPUT', providerKey: 'video-frame' });
  });
});
