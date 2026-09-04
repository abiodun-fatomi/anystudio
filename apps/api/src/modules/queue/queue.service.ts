/**
 * The queue producer.
 *
 * `enqueue()` NEVER THROWS AND NEVER BLOCKS A REQUEST
 * ------------------------------------------------
 * By the time this is called the generation row exists and the credits are
 * held — the customer's request has already succeeded. If Redis is down, the
 * right outcome is "202 Accepted, a little slower", not "500". So a failed
 * enqueue is logged as a WARN with the generation id and the reason, the
 * response goes out, and the worker's dispatcher — which polls QUEUED rows
 * whose queue job never arrived — picks it up within its poll interval.
 *
 * The job id is the generation id. BullMQ refuses a duplicate job id, so a
 * dispatcher re-enqueuing a row the API did in fact enqueue a moment ago
 * cannot produce two jobs for one generation.
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { QUEUES, queueFor, type Capability, type GenerationJob, type QueueName } from '@anystudio/shared';
import { createRedis } from '../../../config/redis';
import { logger } from '../../../config/logger';

/** How long a request may wait on Redis before it stops waiting. */
const ENQUEUE_TIMEOUT_MS = 3_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not complete within ${ms}ms (redis unreachable?)`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export interface EnqueueResult {
  queued: boolean;
  queue: QueueName;
  /** Why it was not queued, when it was not. Operator-facing. */
  reason?: string;
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly redis: Redis | undefined;
  private readonly queues = new Map<QueueName, Queue<GenerationJob>>();

  constructor() {
    this.redis = createRedis('queue', 'queue-producer');
    if (this.redis) {
      for (const name of Object.values(QUEUES)) {
        this.queues.set(
          name,
          new Queue<GenerationJob>(name, {
            connection: this.redis,
            defaultJobOptions: {
              // Retries are the worker's decision, made from the error kind;
              // BullMQ's own retry would re-run a job whose row already failed.
              attempts: 1,
              removeOnComplete: { age: 3600, count: 1000 },
              removeOnFail: { age: 86_400 },
            },
          }),
        );
      }
    }
  }

  /** Put a generation on its queue. See the file comment for why this cannot fail the request. */
  async enqueue(generationId: string, capability: Capability, opts: { delayMs?: number } = {}): Promise<EnqueueResult> {
    const queue = queueFor(capability);
    const q = this.queues.get(queue);
    if (!q) {
      logger.warn({ generationId, capability, queue }, 'enqueue skipped: no Redis; the dispatcher will pick this row up');
      return { queued: false, queue, reason: 'redis not configured' };
    }
    try {
      // A bounded wait. BullMQ queues commands while Redis is unreachable and
      // would hold this promise open for the whole outage; the request must
      // not wait on that. If the add lands late anyway, the job id is the
      // generation id, so it cannot produce a second job.
      await withTimeout(q.add('generate', { generationId }, { jobId: generationId, delay: opts.delayMs }), ENQUEUE_TIMEOUT_MS, 'enqueue');
      logger.debug({ generationId, capability, queue }, 'generation enqueued');
      return { queued: true, queue };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ generationId, capability, queue, err: reason }, 'enqueue failed: the row is written and the dispatcher will pick it up');
      return { queued: false, queue, reason };
    }
  }

  /** Queue depths for the operations dashboard; zeros when Redis is away. */
  async depths(): Promise<Record<QueueName, { waiting: number; active: number; failed: number } | null>> {
    const out = {} as Record<QueueName, { waiting: number; active: number; failed: number } | null>;
    for (const name of Object.values(QUEUES)) {
      const q = this.queues.get(name);
      try {
        out[name] = q ? await withTimeout(q.getJobCounts('waiting', 'active', 'failed'), ENQUEUE_TIMEOUT_MS, 'depths').then((c) => ({ waiting: c.waiting ?? 0, active: c.active ?? 0, failed: c.failed ?? 0 })) : null;
      } catch {
        out[name] = null;
      }
    }
    return out;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    await this.redis?.quit().catch(() => undefined);
  }
}
