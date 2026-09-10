/**
 * Wires the limiter.
 *
 * Global, because a limit that applies only where someone remembered to add a
 * decorator is not a limit. The table decides which routes get which rules;
 * everything unlisted falls to DEFAULT_RATE_RULE.
 */
import { Global, Module } from '@nestjs/common';
import { RATE_LIMIT_STORE } from './rate-limit.tokens';
import { createRedis, RedisRateLimitStore, ResilientRateLimitStore } from './rate-limit.store';

@Global()
@Module({
  providers: [
    {
      provide: RATE_LIMIT_STORE,
      useFactory: () => {
        const redis = createRedis(process.env.REDIS_URL);
        return new ResilientRateLimitStore(redis ? new RedisRateLimitStore(redis) : undefined);
      },
    },
  ],
  exports: [RATE_LIMIT_STORE],
})
export class RateLimitModule {}
