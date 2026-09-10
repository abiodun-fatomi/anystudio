/** The shared schemas, exercised from the API side where they gate money. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_CODE, CAPABILITIES, QUEUES, parseCapabilityParams, queueFor } from '@anystudio/shared';

describe('capability params', () => {
  it('fills defaults so the worker never sees a missing field', () => {
    const r = parseCapabilityParams('IMAGE_EDIT', { sourceKey: 'ws/2026/09/uploads/a.jpg', prompt: 'on a marble counter' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params).toMatchObject({ preserveProduct: true, aspect: '1:1', sizes: ['feed_square', 'story'] });
  });

  it('names the field that is wrong', () => {
    const r = parseCapabilityParams('IMAGE_TO_VIDEO', { sourceKey: 'ws/a.jpg', prompt: 'spin', durationSec: 30 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.issues)).toEqual(['durationSec']);
  });

  it('rejects a URL where a storage key belongs', () => {
    const r = parseCapabilityParams('BACKGROUND_REMOVE', { sourceKey: 'https://evil.example/x.png' });
    expect(r.ok).toBe(false);
  });

  it('has a cost code and a queue for every capability', () => {
    const queues = Object.values(QUEUES);
    for (const c of CAPABILITIES) {
      expect(DEFAULT_COST_CODE[c]).toMatch(/^[a-z]+(\.[a-z_0-9]+)+$/);
      expect(queues).toContain(queueFor(c));
    }
  });

  // The split that keeps a video moving: waiting on a vendor is cheap and runs
  // wide, ffmpeg on our own box is not and stays capped.
  it('sends our own ffmpeg work to the local queue and vendor work to the heavy one', () => {
    expect(queueFor('VIDEO_STITCH')).toBe(QUEUES.local);
    expect(queueFor('IMAGE_TO_VIDEO')).toBe(QUEUES.heavy);
    expect(queueFor('MUSIC')).toBe(QUEUES.heavy);
    expect(queueFor('TEXT_GENERATE')).toBe(QUEUES.fast);
  });
});
