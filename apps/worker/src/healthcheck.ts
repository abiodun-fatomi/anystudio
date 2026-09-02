/** Container healthcheck: the worker is alive if its heartbeat is fresh. */
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
});

redis
  .get('worker:heartbeat')
  .then((v) => {
    const fresh = v !== null && Date.now() - Number(v) < 90_000;
    process.exit(fresh ? 0 : 1);
  })
  .catch(() => process.exit(1))
  .finally(() => void redis.quit());
