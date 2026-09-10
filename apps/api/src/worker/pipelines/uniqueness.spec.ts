import { describe, expect, it } from 'vitest';
import { NEAR_DUPLICATE, minhash, sharedPhrases, similarity } from './uniqueness';

const A =
  'This handmade ankara tote bag is roomy enough for a laptop and light enough for the market. Bold print, strong straps, and a zip that keeps your things safe. Made in Lagos, ready to ship.';
const B =
  'This handmade ankara tote bag is roomy enough for a laptop and light enough for the market. Bold print, strong straps, and a zip that keeps your things safe. Made in Lagos in a green print, ready to ship.';
const C =
  'Meet the bag that goes from Balogun market to a boardroom without changing. Wax-print cotton, reinforced base, and a laptop sleeve inside. Sewn in Lagos by hand.';
const D = 'Soft leather sandals with a cushioned sole, cut for wide feet. Slip on, walk all day. Available in tan and black.';

describe('uniqueness', () => {
  it('finds the same paragraph with one phrase changed', () => {
    expect(similarity(minhash(A), minhash(B))).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
  });
  it('lets two different descriptions of the same product through', () => {
    expect(similarity(minhash(A), minhash(C))).toBeLessThan(NEAR_DUPLICATE);
  });
  it('sees unrelated products as unrelated', () => {
    expect(similarity(minhash(A), minhash(D))).toBeLessThan(0.1);
  });
  it('is deterministic and fits a Postgres integer', () => {
    const a = minhash(A);
    const b = minhash(A);
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    for (const v of a) expect(v).toBeLessThanOrEqual(0x7fffffff);
  });
  it('quotes the phrases two texts share so the model can avoid them', () => {
    const p = sharedPhrases(A, B);
    expect(p.length).toBeGreaterThan(0);
    expect(p.join(' ')).toContain('ankara tote');
  });
});
