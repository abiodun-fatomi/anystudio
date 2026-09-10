/**
 * Where rate-limit counters live.
 *
 * Two implementations behind one interface, and the reason there are two is
 * the important part: Redis is shared across every instance and is therefore
 * the only place a limit can be enforced correctly, but a limiter that fails
 * requests when Redis blinks has turned a defence into an outage. So Redis is
 * the store, memory is the parachute, and the guard never refuses a request
 * because the limiter itself is broken.
 *
 * The memory store is deliberately weaker and it is worth being clear about
 * how: it counts per instance, so with N instances an attacker gets N times
 * the allowance. That is a bad limit. It is still much better than none, and
 * it is temporary by construction — the moment Redis answers again the shared
 * counters take over.
 */

import Redis from 'ioredis';
import { logger } from '../logger';

export interface RateVerdict {
  allowed: boolean;
  /** Requests left in this window, floored at zero. */
  remaining: number;
  /** Seconds until the window resets. */
  resetSec: number;
}

export interface RateLimitStore {
  /** Count one request against `key`. Never throws; a broken store says "allowed". */
  hit(key: string, limit: number, windowSec: number): Promise<RateVerdict>;
}

/**
 * Fixed window, one round trip.
 *
 * A fixed window lets a caller burst across a boundary — up to 2× the limit
 * in a moment straddling two windows. A sliding log fixes that and costs a
 * sorted set per key with per-request trimming. For "five sign-in attempts a
 * minute" the boundary burst is not the threat model, and the cheaper
 * primitive is the one that stays fast under the load it exists to survive.
 */
const SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return { n, ttl }
`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowSec: number): Promise<RateVerdict> {
    const [count, ttl] = (await this.redis.eval(SCRIPT, 1, key, String(windowSec))) as [number, number];
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      // TTL is -1 for a key with no expiry, which should not happen but must
      // not surface as a negative Retry-After if it ever does.
      resetSec: ttl > 0 ? ttl : windowSec,
    };
  }
}

/** Per-instance counters, used only while Redis is unreachable. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; expiresAt: number }>();

  async hit(key: string, limit: number, windowSec: number): Promise<RateVerdict> {
    const now = Date.now();
    const existing = this.windows.get(key);
    const window = existing && existing.expiresAt > now ? existing : { count: 0, expiresAt: now + windowSec * 1000 };

    window.count += 1;
    this.windows.set(key, window);
    if (this.windows.size > 10_000) this.evictExpired(now);

    return {
      allowed: window.count <= limit,
      remaining: Math.max(0, limit - window.count),
      resetSec: Math.max(1, Math.ceil((window.expiresAt - now) / 1000)),
    };
  }

  /**
   * Only when the map gets large, and only expired entries.
   *
   * Without this a long-lived instance under a key-spraying attack grows the
   * map without bound — the limiter becomes the memory leak it was added to
   * prevent.
   */
  private evictExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.expiresAt <= now) this.windows.delete(key);
    }
  }
}

/**
 * Redis when it answers, memory when it does not.
 *
 * State changes are logged once each way rather than per request: a Redis
 * outage under load would otherwise write a line per request to the very log
 * you are reading to work out what happened.
 */
export class ResilientRateLimitStore implements RateLimitStore {
  private readonly memory = new MemoryRateLimitStore();
  private degraded = false;

  constructor(private readonly redis?: RedisRateLimitStore) {
    if (!redis) {
      this.degraded = true;
      logger.warn({ store: 'memory' }, 'rate limiting is per-instance: REDIS_URL is not set, so limits are not shared between instances');
    }
  }

  async hit(key: string, limit: number, windowSec: number): Promise<RateVerdict> {
    if (this.redis) {
      try {
        const verdict = await this.redis.hit(key, limit, windowSec);
        if (this.degraded) {
          this.degraded = false;
          logger.info({ store: 'redis' }, 'rate limiting is shared again: Redis is answering');
        }
        return verdict;
      } catch (err) {
        if (!this.degraded) {
          this.degraded = true;
          logger.error({ err, store: 'memory' }, 'Redis unreachable: rate limiting has fallen back to per-instance counters');
        }
      }
    }
    return this.memory.hit(key, limit, windowSec);
  }

  /** For the readiness endpoint and tests. */
  get usingFallback(): boolean {
    return this.degraded;
  }
}

/**
 * Connect to Redis, or return undefined and let the caller run degraded.
 *
 * `lazyConnect` plus a short timeout on purpose: the API must boot and serve
 * traffic whether or not Redis is up. A limiter that blocks startup would
 * make a cache outage a total outage.
 */
export function createRedis(url: string | undefined): Redis | undefined {
  if (!url) return undefined;
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false, // fail fast into the fallback rather than queueing
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 500, // a limiter that waits is worse than one that guesses
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  // Errors are expected while Redis is down; the store logs the state change,
  // so this listener exists only to stop ioredis throwing on an unhandled event.
  redis.on('error', () => undefined);
  redis.connect().catch(() => undefined);
  return redis;
}
