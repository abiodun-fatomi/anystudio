import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { enhancePhoto } from './enhance';

const solid = (v: number, alpha = 1) =>
  sharp({ create: { width: 64, height: 64, channels: 4, background: { r: v, g: v, b: v, alpha } } })
    .png()
    .toBuffer();
async function value(v: number) {
  const result = await enhancePhoto(await solid(v));
  return (await result.raw().toBuffer())[0]!;
}
describe('adaptive non-generative enhancement', () => {
  it('lifts an underexposed photo more than the old fixed 3% brightness change', async () => {
    expect(await value(40)).toBeGreaterThan(65);
  });
  it('does not brighten an already well-exposed image', async () => {
    expect(Math.abs((await value(130)) - 130)).toBeLessThanOrEqual(2);
  });
  it('gently reduces excessively bright midtones', async () => {
    const out = await value(220);
    expect(out).toBeLessThan(220);
    expect(out).toBeGreaterThan(175);
  });
  it('does not invent detail in black or clipped white', async () => {
    expect(await value(0)).toBe(0);
    expect(await value(255)).toBe(255);
  });
  it('preserves alpha and original dimensions', async () => {
    const out = await (await enhancePhoto(await solid(40, 0.5))).raw().toBuffer({ resolveWithObject: true });
    expect(out.info).toMatchObject({ width: 64, height: 64, channels: 4 });
    expect(out.data[3]).toBe(128);
  });
  it('corrects EXIF orientation without cropping', async () => {
    const source = await sharp({ create: { width: 40, height: 80, channels: 3, background: '#444444' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await (await enhancePhoto(source)).png().toBuffer({ resolveWithObject: true });
    expect(out.info).toMatchObject({ width: 80, height: 40 });
  });
  it('reduces isolated impulse noise on a flat image', async () => {
    const pixels = Buffer.alloc(100 * 100 * 3, 130);
    for (let y = 2; y < 98; y += 3) for (let x = 2; x < 98; x += 3) pixels.fill(255, (y * 100 + x) * 3, (y * 100 + x) * 3 + 3);
    const source = await sharp(pixels, { raw: { width: 100, height: 100, channels: 3 } })
      .png()
      .toBuffer();
    const out = await (await enhancePhoto(source)).removeAlpha().raw().toBuffer();
    expect(out[202 * 3]).toBeLessThan(160);
  });
});
