/**
 * The no-model path, tested without a model.
 *
 * The inference path needs 200 MB of weights that CI has no business
 * downloading, so what is asserted here is the part that decides whether the
 * cheap path may be used at all — which is also the part that can quietly
 * ruin a cutout by keying a product that happens to match its backdrop.
 */

import { describe, expect, it } from 'vitest';
import { borderColour, coverage, keyOut, type RawImage } from './matting.adapter';

/** A solid canvas with an optional rectangle of another colour in the middle. */
function canvas(
  width: number,
  height: number,
  bg: [number, number, number],
  subject?: { colour: [number, number, number]; inset: number },
): RawImage {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = subject ? x >= subject.inset && x < width - subject.inset && y >= subject.inset && y < height - subject.inset : false;
      const c = inside && subject ? subject.colour : bg;
      const i = (y * width + x) * 3;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
    }
  }
  return { data, width, height };
}

describe('the flat-backdrop test', () => {
  it('reads a light tent as flat', () => {
    const img = canvas(64, 64, [248, 248, 250], { colour: [20, 30, 40], inset: 20 });
    const { colour, spread } = borderColour(img);
    expect(spread).toBeLessThan(14);
    expect(Math.round(colour[0])).toBeGreaterThan(240);
  });

  it('reads a busy market background as not flat', () => {
    const img = canvas(64, 64, [200, 120, 60]);
    // Scatter the border the way a patterned cloth or a tiled floor does.
    for (let x = 0; x < 64; x += 3) {
      const i = x * 3;
      img.data[i] = 20;
      img.data[i + 1] = 200;
      img.data[i + 2] = 90;
    }
    expect(borderColour(img).spread).toBeGreaterThan(14);
  });
});

describe('keying a flat backdrop', () => {
  it('drops the background and keeps the subject', () => {
    const img = canvas(64, 64, [255, 255, 255], { colour: [10, 10, 10], inset: 16 });
    const alpha = keyOut(img, [255, 255, 255], 20, 52);
    // A corner is background, the centre is product.
    expect(alpha[0]).toBe(0);
    expect(alpha[32 * 64 + 32]).toBe(255);
    expect(coverage(alpha)).toBeGreaterThan(0.1);
    expect(coverage(alpha)).toBeLessThan(0.9);
  });

  it('reports near-total coverage when the subject matches its backdrop', () => {
    // A white bottle on white: the key cannot see it, and the near-zero
    // coverage is exactly the signal the adapter uses to fall back.
    const img = canvas(64, 64, [252, 252, 252], { colour: [250, 250, 250], inset: 16 });
    expect(coverage(keyOut(img, [252, 252, 252], 20, 52))).toBeLessThan(0.02);
  });

  it('ramps the edge instead of stepping it', () => {
    const img = canvas(3, 1, [255, 255, 255]);
    img.data[3] = 235;
    img.data[4] = 235;
    img.data[5] = 235;
    const alpha = keyOut(img, [255, 255, 255], 20, 52);
    expect(alpha[1]).toBeGreaterThan(0);
    expect(alpha[1]).toBeLessThan(255);
  });
});
