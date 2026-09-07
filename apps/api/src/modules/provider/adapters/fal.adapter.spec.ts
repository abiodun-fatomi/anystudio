/**
 * The clip length we ask fal for.
 *
 * Our plans are built on 5 and 8 seconds. wan-2.5 takes 5 or 10, and answers
 * an 8 with
 *
 *   {"type":"literal_error","loc":["body","duration"],"msg":"Input should be '5' or '10'","input":"8"}
 *
 * before it renders anything — three of every four shots in a 30-second ad,
 * each one then falling through to vertex:veo-3.1-fast at 260 minor against
 * fal's 80. The bug was billed as well as logged.
 *
 * These tests are about which length we send, not about the vendor call.
 */
import { describe, expect, it } from 'vitest';
import { snapDuration } from './fal.adapter';

const WAN = [5, 10] as const;

describe('choosing a clip length a vendor will accept', () => {
  it('sends what the plan asked for when the vendor accepts it', () => {
    expect(snapDuration(5, WAN)).toBe(5);
    expect(snapDuration(10, WAN)).toBe(10);
  });

  it('never sends a length the vendor has said it will refuse', () => {
    // The reproduction. Whatever it picks, it must not be 8.
    expect(snapDuration(8, WAN)).not.toBe(8);
    expect(WAN).toContain(snapDuration(8, WAN));
  });

  it('rounds down rather than to the nearest, so the ad cannot run long', () => {
    // 8 is closer to 10 than to 5, and 10 is still the wrong answer: the
    // customer bought a 30-second ad, and four shots that each quietly gain
    // two seconds hand them a 40-second one at a 30-second price.
    expect(snapDuration(8, WAN)).toBe(5);
  });

  it('takes the shortest on offer when everything the vendor has runs long', () => {
    expect(snapDuration(3, WAN)).toBe(5);
  });

  it('leaves the length alone for an endpoint with no grid of its own', () => {
    // Most vendors take both of ours; absent a table we must not invent one.
    expect(snapDuration(8, undefined)).toBe(8);
    expect(snapDuration(8, [])).toBe(8);
  });
});
