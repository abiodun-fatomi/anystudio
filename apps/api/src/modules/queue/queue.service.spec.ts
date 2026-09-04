/**
 * The fail-safe: a queue that cannot reach Redis must say so, never throw,
 * and never block the request that already succeeded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { QueueService } from './queue.service';

describe('QueueService', () => {
  const saved = process.env.REDIS_URL;
  afterEach(() => { if (saved === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved; });

  it('reports "not queued" with a reason when there is no Redis, instead of throwing', async () => {
    delete process.env.REDIS_URL;
    const q = new QueueService();
    const r = await q.enqueue('11111111-1111-4111-8111-111111111111', 'IMAGE_EDIT');
    expect(r).toEqual({ queued: false, queue: 'media.fast', reason: 'redis not configured' });
    expect(await q.depths()).toEqual({ 'media.fast': null, 'media.heavy': null });
    await q.onModuleDestroy();
  });

  it('routes video to the heavy queue and images to the fast one', async () => {
    delete process.env.REDIS_URL;
    const q = new QueueService();
    expect((await q.enqueue('a', 'IMAGE_TO_VIDEO')).queue).toBe('media.heavy');
    expect((await q.enqueue('b', 'TEXT_GENERATE')).queue).toBe('media.fast');
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
