/**
 * The fidelity score on images we can reason about: a "product" (a
 * textured shape) on a background, then the same product on a new
 * background, the product recoloured, the product replaced. The score must
 * order them the way a seller would.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { FIDELITY, fidelity } from './fidelity';
import { pasteProduct, pasteProductAt } from './image';

const W = 320;
const H = 320;

/** A textured "product": a disc with stripes, so structure exists inside the mask. */
function productSvg(fill: string, stripes: string, cx = 160, cy = 160, r = 90): string {
  // Broad bands, not a fine grating: a label, not a test chart. Fine stripes alias
  // differently at every scale and would fail any resampling-based comparison.
  const bands: Array<[number, number]> = [
    [0.12, 0.05],
    [0.3, 0.12],
    [0.55, 0.06],
    [0.66, 0.16],
    [0.9, 0.05],
  ];
  const lines = bands
    .map(
      ([at, w]) =>
        `<line x1="${cx - r}" y1="${cy - r + at * 2 * r}" x2="${cx + r}" y2="${cy - r + at * 2 * r}" stroke="${stripes}" stroke-width="${w * 2 * r}"/>`,
    )
    .join('');
  return `<clipPath id="c"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath><circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/><g clip-path="url(#c)">${lines}</g>`;
}
const scene = (bg: string, product: string) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bg}${product}</svg>`))
    .png()
    .toBuffer();
const cutout = (product: string) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${product}</svg>`))
    .png()
    .toBuffer();

const PRODUCT = productSvg('#D6006E', '#FFFFFF');
const PLAIN = '<rect width="100%" height="100%" fill="#DDDDDD"/>';
const MARBLE =
  '<rect width="100%" height="100%" fill="#8A8A8A"/><circle cx="60" cy="60" r="40" fill="#BBBBBB"/><rect x="200" y="220" width="100" height="80" fill="#666666"/>';

describe('fidelity', () => {
  it('does not accept a replaced product when the expanded-canvas search is enabled', async () => {
    const src = await scene(PLAIN, PRODUCT);
    const mask = await cutout(PRODUCT);
    const replaced = await scene(MARBLE, productSvg('#0066CC', '#0066CC', 160, 160, 60));
    const out = await sharp(replaced).extend({ left: 320, right: 320, top: 320, bottom: 320, background: '#888888' }).png().toBuffer();
    const report = await fidelity(src, mask, out, { expandedCanvas: true });
    expect(report.score).toBeLessThan(FIDELITY.keep);
    expect(report.structure).toBeLessThan(FIDELITY.locate);
  });

  it.each([3, 4])('keeps an unchanged product when outpainting enlarges both canvas dimensions %sx', async (factor) => {
    const src = await scene(PLAIN, PRODUCT);
    const mask = await cutout(PRODUCT);
    const pad = (W * (factor - 1)) / 2;
    const out = await sharp(src).extend({ left: pad, right: pad, top: pad, bottom: pad, background: '#888888' }).png().toBuffer();
    const report = await fidelity(src, mask, out, { expandedCanvas: true });
    // Heavy downsampling can lose fine detail, but it must still locate the
    // original confidently and qualify for the existing repair path.
    expect(report.score).toBeGreaterThanOrEqual(FIDELITY.composite);
    expect(report.structure).toBeGreaterThanOrEqual(FIDELITY.locate);
    expect(report.placed?.scale).toBeLessThan(0.5);
    expect(report.placed?.x).toBeCloseTo(0.5, 1);
  });

  it('scores an untouched product on a new background as kept', async () => {
    const src = await scene(PLAIN, PRODUCT);
    const cut = await cutout(PRODUCT);
    const out = await scene(MARBLE, PRODUCT);
    const r = await fidelity(src, cut, out);
    expect(r.score).toBeGreaterThanOrEqual(FIDELITY.keep);
    expect(r.coverage).toBeGreaterThan(0.1);
  });

  it('scores a recoloured product below keep, and a replaced product below composite', async () => {
    const src = await scene(PLAIN, PRODUCT);
    const cut = await cutout(PRODUCT);
    const recoloured = await fidelity(src, cut, await scene(MARBLE, productSvg('#0066CC', '#FFFFFF')));
    const replaced = await fidelity(src, cut, await scene(MARBLE, productSvg('#0066CC', '#0066CC', 160, 160, 60)));
    expect(recoloured.score).toBeLessThan(FIDELITY.keep);
    expect(replaced.score).toBeLessThan(FIDELITY.composite);
    expect(replaced.score).toBeLessThan(recoloured.score);
  });

  it('finds the product when the frame changed shape and it moved, and reports where', async () => {
    const src = await scene(PLAIN, PRODUCT);
    const mask = await cutout(PRODUCT);
    // A 16:9 output with the same product at the left third, a little smaller.
    const wide = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">${MARBLE.replace('width="100%" height="100%"', 'width="640" height="360"')}${productSvg('#D6006E', '#FFFFFF', 200, 180, 75)}</svg>`,
      ),
    )
      .png()
      .toBuffer();
    const r = await fidelity(src, mask, wide);
    expect(r.score).toBeGreaterThanOrEqual(FIDELITY.keep);
    expect(r.placed?.x).toBeCloseTo(200 / 640, 1);
    expect(r.placed?.y).toBeCloseTo(0.5, 1);
    expect(r.placed?.scale).toBeLessThan(1);
  });

  it('pastes the original product back where the model put it, in a reshaped frame', async () => {
    const src = await scene(PLAIN, PRODUCT);
    const mask = await cutout(PRODUCT);
    // The model recoloured the product (blue) and moved it to the left third of a 16:9 frame.
    const wide = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">${MARBLE.replace('width="100%" height="100%"', 'width="640" height="360"')}${productSvg('#2255DD', '#FFFFFF', 200, 180, 75)}</svg>`,
      ),
    )
      .png()
      .toBuffer();
    const r = await fidelity(src, mask, wide);
    expect(r.score).toBeLessThan(FIDELITY.keep);
    expect(r.structure).toBeGreaterThanOrEqual(FIDELITY.locate);
    const fixed = await pasteProductAt(wide, mask, r.placed!);
    // The centre of where it was found is now the original magenta, not the model's blue.
    const { data } = await sharp(fixed).extract({ left: 196, top: 176, width: 8, height: 8 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const [rr, gg, bb] = [data[0]!, data[1]!, data[2]!];
    expect(rr).toBeGreaterThan(180);
    expect(bb).toBeLessThan(160);
    expect(gg).toBeLessThan(80);
    // And the fidelity of the fixed image is high again.
    expect((await fidelity(src, mask, fixed)).score).toBeGreaterThanOrEqual(FIDELITY.keep);
  });

  it('returns zero when there is no product to judge', async () => {
    const src = await scene(PLAIN, PRODUCT);
    const empty = await cutout('');
    const r = await fidelity(src, empty, await scene(MARBLE, PRODUCT));
    expect(r.score).toBe(0);
    expect(r.coverage).toBe(0);
  });

  it('pasting the original pixels back restores a drifted product to a keep score', async () => {
    const src = await scene(PLAIN, PRODUCT);
    const cut = await cutout(PRODUCT);
    const drifted = await scene(MARBLE, productSvg('#B0106A', '#EEEEEE'));
    const before = await fidelity(src, cut, drifted);
    const pasted = await pasteProduct(new Uint8Array(drifted), new Uint8Array(cut));
    const after = await fidelity(src, cut, pasted);
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.score).toBeGreaterThanOrEqual(FIDELITY.keep);
    const meta = await sharp(pasted).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
  });
});
