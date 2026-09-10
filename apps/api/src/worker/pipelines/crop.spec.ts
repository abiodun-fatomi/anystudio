import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { focalCrop, maskFocal, sharpnessFocal, window } from './crop';

/** A 1600×900 scene: a bright, soft window on the right; a sharp dark bottle at the left third. */
async function scene(): Promise<Buffer> {
  const bottle = Buffer.from(
    `<svg width="1600" height="900"><rect width="1600" height="900" fill="#d9cfc2"/><rect x="900" y="60" width="600" height="700" fill="#fff5e0"/><rect x="380" y="180" width="200" height="600" rx="40" fill="#2a2a2e"/><text x="420" y="500" font-size="60" fill="#ddd">28oz</text></svg>`,
  );
  const sharpPart = await sharp(bottle).png().toBuffer();
  // Blur everything, then paste the sharp bottle back so only it has detail.
  const blurred = await sharp(sharpPart).blur(18).png().toBuffer();
  const bottleOnly = await sharp(sharpPart).extract({ left: 360, top: 160, width: 240, height: 640 }).png().toBuffer();
  return sharp(blurred)
    .composite([{ input: bottleOnly, left: 360, top: 160 }])
    .png()
    .toBuffer();
}

describe('export crop aiming', () => {
  it('finds the product by sharpness when there is no mask, not the bright window', async () => {
    const f = await sharpnessFocal(await scene());
    expect(f.from).toBe('sharpness');
    expect(f.x).toBeGreaterThan(0.2);
    expect(f.x).toBeLessThan(0.42);
  });

  it('finds the product by its mask when there is one', async () => {
    const cutout = await sharp(Buffer.from('<svg width="1600" height="900"><rect x="380" y="180" width="200" height="600" fill="#000"/></svg>'))
      .png()
      .toBuffer();
    const f = await maskFocal(cutout);
    expect(f?.from).toBe('mask');
    expect(f!.x).toBeCloseTo(0.3, 1);
    expect(f!.y).toBeCloseTo(0.53, 1);
  });

  it('places the window on the focal point and clamps it to the frame', () => {
    expect(window(1600, 900, 1080, 1920, { x: 0.3, y: 0.5 })).toEqual({ left: 227, top: 0, width: 506, height: 900 });
    expect(window(1600, 900, 1080, 1920, { x: 0.02, y: 0.5 })).toEqual({ left: 0, top: 0, width: 506, height: 900 });
    expect(window(1600, 900, 1080, 1080, { x: 0.95, y: 0.5 })).toEqual({ left: 700, top: 0, width: 900, height: 900 });
    expect(window(900, 1600, 1920, 1080, { x: 0.5, y: 0.9 })).toEqual({ left: 0, top: 1094, width: 900, height: 506 });
  });

  it('keeps the bottle inside a story crop of a landscape scene', async () => {
    const img = await scene();
    const story = await focalCrop(img, 1080, 1920, { x: 0.3, y: 0.53 });
    const meta = await sharp(story).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
    // The middle column of the story should be dark (the bottle), not the beige background.
    const { data } = await sharp(story).extract({ left: 500, top: 900, width: 80, height: 80 }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    expect(mean).toBeLessThan(90);
  });
});
