/**
 * Worker entrypoint.
 *
 * Separate process and separate deploy from the API: provider calls take tens
 * of seconds and must never compete with webhook acknowledgements, which have
 * to return fast or the sender retries and we process the event twice.
 */

import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required by BullMQ
});

const HEARTBEAT_KEY = 'worker:heartbeat';

/** The platform healthcheck reads this rather than probing a port. */
async function heartbeat(): Promise<void> {
  await redis.set(HEARTBEAT_KEY, Date.now().toString(), 'EX', 90);
}

async function main(): Promise<void> {
  await heartbeat();
  setInterval(heartbeat, 30_000);
  console.log(JSON.stringify({ level: 'info', msg: 'worker started', env: process.env.APP_ENV }));

  // Queue consumers are registered here once the generation pipeline exists.

  const stop = async (signal: string) => {
    console.log(JSON.stringify({ level: 'info', msg: 'worker stopping', signal }));
    // Consumers get closed here so an in-flight job finishes rather than being
    // killed after its credits were already spent.
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'worker failed to start', err: String(err) }));
  process.exit(1);
});
