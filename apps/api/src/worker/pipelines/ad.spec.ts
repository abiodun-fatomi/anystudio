import { describe, expect, it } from 'vitest';
import { adCaptionWindow, allocateAdTimeline, orderedAdChildren } from './ad';
import { capabilityParams } from '@anystudio/shared';
import type { Generation } from '@prisma/client';

describe('safe ad assembly', () => {
  const child = (shotIndex: number) => ({ input: { shotIndex } }) as Generation;
  it('orders shots by their durable indices and rejects missing or duplicate shots', () => {
    const p = capabilityParams.IMAGE_TO_VIDEO.parse({ sourceKey: 'ws/product.jpg', shots: 2 });
    expect(orderedAdChildren([child(1), child(0)], p).map((c) => c.input)).toEqual([{ shotIndex: 0 }, { shotIndex: 1 }]);
    expect(() => orderedAdChildren([], p)).toThrow(/complete ordered set/);
    expect(() => orderedAdChildren([child(0)], p)).toThrow(/complete ordered set/);
    expect(() => orderedAdChildren([child(0), child(0)], p)).toThrow(/complete ordered set/);
  });
  it('accounts for the presenter slot without expecting it to be a child', () => {
    const p = capabilityParams.IMAGE_TO_VIDEO.parse({ sourceKey: 'ws/product.jpg', shots: 2, format: 'ugc', presenter: { kind: 'stock', key: 'daphne' } });
    expect(orderedAdChildren([child(1)], p)).toHaveLength(1);
    expect(() => orderedAdChildren([child(0)], p)).toThrow(/complete ordered set/);
  });
  it.each([500, 550, 600, 8000])('keeps captions inside a %i ms shot with positive duration', (duration) => {
    const window = adCaptionWindow(12000, duration);
    expect(window.fromMs).toBeGreaterThanOrEqual(12000);
    expect(window.toMs).toBeGreaterThan(window.fromMs);
    expect(window.toMs).toBeLessThanOrEqual(12000 + duration);
  });
});

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
