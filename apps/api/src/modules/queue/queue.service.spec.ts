/**
 * The fail-safe: a queue that cannot reach Redis must say so, never throw,
 * and never block the request that already succeeded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { QueueService, isFinished } from './queue.service';

describe('which queue jobs are tombstones', () => {
  /**
   * The bug this decides: a generation is enqueued under its own id more
   * than once by design — an ad's parent plans, then assembles; a retry runs
   * the same row again — and BullMQ answers an add whose id already exists
   * by returning the old job and creating nothing. A finished job therefore
   * has to be cleared out of the way first.
   */
  it('counts a job that has finished, in either direction', () => {
    expect(isFinished('completed')).toBe(true);
    expect(isFinished('failed')).toBe(true);
  });

  it('never counts one that is still queued or running', () => {
    // Removing one of these would lose queued work or orphan a live job —
    // and these are the duplicates the shared job id exists to prevent.
    for (const live of ['waiting', 'waiting-children', 'delayed', 'active', 'prioritized', 'paused']) {
      expect(isFinished(live), `"${live}" is live work, not a tombstone`).toBe(false);
    }
  });

  it('does not count a job that has already vanished', () => {
    expect(isFinished('unknown')).toBe(false);
  });
});

describe('QueueService', () => {
  const saved = process.env.REDIS_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved;
  });

  it('reports "not queued" with a reason when there is no Redis, instead of throwing', async () => {
    delete process.env.REDIS_URL;
    const q = new QueueService();
    const r = await q.enqueue('11111111-1111-4111-8111-111111111111', 'IMAGE_EDIT');
    expect(r).toEqual({ queued: false, queue: 'media.fast', reason: 'redis not configured' });
    expect(await q.depths()).toEqual({ 'media.fast': null, 'media.heavy': null, 'media.local': null });
    await q.onModuleDestroy();
  });

  it('routes video to the heavy queue, images to the fast one and our own ffmpeg to the local one', async () => {
    delete process.env.REDIS_URL;
    const q = new QueueService();
    expect((await q.enqueue('a', 'IMAGE_TO_VIDEO')).queue).toBe('media.heavy');
    expect((await q.enqueue('b', 'TEXT_GENERATE')).queue).toBe('media.fast');
    expect((await q.enqueue('c', 'VIDEO_STITCH')).queue).toBe('media.local');
    await q.onModuleDestroy();
  });

  it('degrades, not fails, when Redis is configured but unreachable', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1'; // nothing listens here
    const q = new QueueService();
    const r = await q.enqueue('22222222-2222-4222-8222-222222222222', 'IMAGE_EDIT');
    expect(r.queued).toBe(false);
    expect(r.reason).toBeTruthy();
    await q.onModuleDestroy();
  }, 20_000);
});
