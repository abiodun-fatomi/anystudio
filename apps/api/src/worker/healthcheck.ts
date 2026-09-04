/**
 * Container healthcheck for the worker: alive if its Redis heartbeat is
 * fresh. With no Redis configured there is nothing to read, and a process
 * that is up is the best signal available — exit 0.
 */
import Redis from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) process.exit(0);

const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
redis
  .get('worker:heartbeat')
  .then((v) => {
    const fresh = v !== null && Date.now() - Number(v) < 90_000;
    process.exit(fresh ? 0 : 1);
  })
  .catch(() => process.exit(1))
  .finally(() => void redis.quit());
