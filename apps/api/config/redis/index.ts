/**
 * Redis connections, and the stance the whole codebase takes towards Redis.
 *
 * REDIS IS AN ACCELERATOR, NOT A SOURCE OF TRUTH
 * ---------------------------------------------
 * Every fact that matters lives in Postgres. Redis carries three things and
 * every one of them has a fallback that works with Redis gone:
 *
 *   the job queue      → the generation row IS the job; the worker's
 *                        dispatcher polls QUEUED rows when the queue is silent
 *   progress events    → the worker also writes stage/progress onto the row;
 *                        a stream that cannot subscribe polls the row instead
 *   rate-limit counts  → an in-memory store takes over (rate-limit.store.ts)
 *
 * So a Redis outage degrades latency, never correctness: nothing is charged
 * twice, nothing is lost, and the studio keeps showing the truth a little
 * later than usual. That is a deliberate design, and the reason none of the
 * factories here throw when Redis is unreachable.
 *
 * TWO CONNECTION SHAPES
 * ---------------------
 * BullMQ requires `maxRetriesPerRequest: null` and its own blocking
 * connections; pub/sub subscribers are dedicated by protocol. Everything else
 * uses a short-timeout client that fails fast into its fallback. Mixing them
 * is how a stalled BRPOP blocks a rate-limit check.
 */

import Redis, { type RedisOptions } from 'ioredis';
import { logger } from '../logger';

export type RedisRole = 'queue' | 'pubsub' | 'general';

const BASE: RedisOptions = {
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 250, 5_000),
  reconnectOnError: () => true,
};

const BY_ROLE: Record<RedisRole, RedisOptions> = {
  // BullMQ owns retry semantics; it must be null or bullmq refuses the connection.
  queue: { ...BASE, maxRetriesPerRequest: null, enableOfflineQueue: true, connectTimeout: 5_000 },
  // A subscriber sits idle for hours; no command timeout, reconnect forever.
  pubsub: { ...BASE, maxRetriesPerRequest: null, enableOfflineQueue: true, connectTimeout: 5_000 },
  // Everything else fails fast so the caller can fall back rather than wait.
  general: { ...BASE, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000, commandTimeout: 1_000 },
};

/** True when REDIS_URL is configured at all. Absent means "run without it", not an error. */
export const redisConfigured = (): boolean => Boolean(process.env.REDIS_URL);

/**
 * A connection that never throws on creation and tells the story of its
 * availability once per state change — not once per failed command, which
 * is how a two-minute outage becomes forty thousand log lines.
 */
export function createRedis(role: RedisRole, name: string = role): Redis | undefined {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn({ redis: name }, 'REDIS_URL unset: running without Redis; queue and events fall back to the database');
    return undefined;
  }
  const redis = new Redis(url, BY_ROLE[role]);
  let down = false;
  redis.on('error', (err: Error) => {
    if (!down) {
      down = true;
      logger.warn({ redis: name, err: err.message }, 'redis unavailable: falling back until it answers again');
    }
  });
  redis.on('ready', () => {
    if (down) logger.info({ redis: name }, 'redis is back: fallbacks stand down');
    down = false;
  });
  redis.connect().catch(() => undefined); // the error listener already told the story
  return redis;
}

/** A yes/no the health endpoint and the worker can print without throwing. */
export async function redisHealthy(redis: Redis | undefined): Promise<boolean> {
  if (!redis) return false;
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}
