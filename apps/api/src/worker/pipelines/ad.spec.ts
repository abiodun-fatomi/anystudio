import { describe, expect, it } from 'vitest';
import { allocateAdTimeline } from './ad';

describe('the customer-facing ad timeline', () => {
  it.each([
    [15_000, [8_000, 8_000]],
    [30_000, [8_000, 8_000, 8_000, 5_000]],
    [45_000, [8_000, 8_000, 8_000, 8_000, 8_000, 5_000]],
    [60_000, [8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 5_000]],
  ])('fits provider-grid shots plus the end card into exactly %i ms', (target, raw) => {
    const timeline = allocateAdTimeline(raw, target, { endCard: true });
    expect(timeline.reduce((sum, duration) => sum + duration, 0) + 2_000).toBe(target);
    expect(timeline.every((duration) => duration >= 500)).toBe(true);
  });

  it('preserves presenter speech and assigns the exact remainder to product shots', () => {
    const timeline = allocateAdTimeline([8_000, 8_000, 5_000], 30_000, { endCard: true, presenterMs: 9_200 });
    expect(timeline[0]).toBe(9_200);
    expect(timeline.reduce((sum, duration) => sum + duration, 0) + 2_000).toBe(30_000);
  });

  it('refuses presenter speech that leaves no meaningful product footage', () => {
    expect(() => allocateAdTimeline([8_000], 15_000, { endCard: true, presenterMs: 12_600 })).toThrow(/presenter speech is too long/i);
  });

  it('makes a one-shot reel exactly the requested length without an end card', () => {
    expect(allocateAdTimeline([10_000], 8_000)).toEqual([8_000]);
  });
});
