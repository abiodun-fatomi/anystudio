import { describe, expect, it, vi } from 'vitest';
import { MemoryRateLimitStore, ResilientRateLimitStore } from './rate-limit.store';
import type { RedisRateLimitStore } from './rate-limit.store';

/** A Redis store that answers, or refuses, on demand. */
const fakeRedis = (behaviour: { fail?: boolean } = {}) => {
  let count = 0;
  return {
    hit: vi.fn(async (_key: string, limit: number, windowSec: number) => {
      if (behaviour.fail) throw new Error('ECONNREFUSED');
      count += 1;
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetSec: windowSec };
    }),
  } as unknown as RedisRateLimitStore;
};

describe('MemoryRateLimitStore', () => {
  it('allows up to the limit and refuses after it', async () => {
    const store = new MemoryRateLimitStore();
    const hits = [];
    for (let i = 0; i < 4; i++) hits.push(await store.hit('k', 3, 60));

    expect(hits.map((h) => h.allowed)).toEqual([true, true, true, false]);
    expect(hits.map((h) => h.remaining)).toEqual([2, 1, 0, 0]);
  });

  it('counts each key separately', async () => {
    const store = new MemoryRateLimitStore();
    await store.hit('a', 1, 60);
    expect((await store.hit('b', 1, 60)).allowed).toBe(true);
    expect((await store.hit('a', 1, 60)).allowed).toBe(false);
  });

  it('starts a fresh window once the old one expires', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryRateLimitStore();
      expect((await store.hit('k', 1, 60)).allowed).toBe(true);
      expect((await store.hit('k', 1, 60)).allowed).toBe(false);

      vi.advanceTimersByTime(61_000);
      expect((await store.hit('k', 1, 60)).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ResilientRateLimitStore', () => {
  it('uses Redis while Redis answers', async () => {
    const redis = fakeRedis();
    const store = new ResilientRateLimitStore(redis);

    expect((await store.hit('k', 2, 60)).allowed).toBe(true);
    expect(redis.hit).toHaveBeenCalledOnce();
    expect(store.usingFallback).toBe(false);
  });

  it('falls back to memory rather than failing the request when Redis is down', async () => {
    const store = new ResilientRateLimitStore(fakeRedis({ fail: true }));

    const verdict = await store.hit('k', 2, 60);

    expect(verdict.allowed).toBe(true);
    expect(store.usingFallback).toBe(true);
  });

  it('still enforces a limit while degraded', async () => {
    const store = new ResilientRateLimitStore(fakeRedis({ fail: true }));

    const allowed = [];
    for (let i = 0; i < 3; i++) allowed.push((await store.hit('k', 2, 60)).allowed);

    // Per-instance rather than shared, but a limit nonetheless.
    expect(allowed).toEqual([true, true, false]);
  });

  it('runs on memory when no Redis is configured at all', async () => {
    const store = new ResilientRateLimitStore(undefined);

    expect(store.usingFallback).toBe(true);
    expect((await store.hit('k', 1, 60)).allowed).toBe(true);
    expect((await store.hit('k', 1, 60)).allowed).toBe(false);
  });

  it('goes back to Redis as soon as it recovers', async () => {
    const behaviour = { fail: true };
    const redis = fakeRedis(behaviour);
    const store = new ResilientRateLimitStore(redis);

    await store.hit('k', 5, 60);
    expect(store.usingFallback).toBe(true);

    behaviour.fail = false;
    await store.hit('k', 5, 60);
    expect(store.usingFallback).toBe(false);
  });
});
