/**
 * The fidelity score on images we can reason about: a "product" (a
 * textured shape) on a background, then the same product on a new
 * background, the product recoloured, the product replaced. The score must
 * order them the way a seller would.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { FIDELITY, fidelity } from './fidelity';
import { pasteProduct } from './image';

const W = 320;
const H = 320;

/** A textured "product": a disc with stripes, so structure exists inside the mask. */
function productSvg(fill: string, stripes: string, cx = 160, cy = 160, r = 90): string {
  const lines = Array.from(
    { length: 9 },
    (_, i) =>
      `<line x1="${cx - r}" y1="${cy - r + (i * (2 * r)) / 8}" x2="${cx + r}" y2="${cy - r + (i * (2 * r)) / 8}" stroke="${stripes}" stroke-width="6"/>`,
  ).join('');
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
