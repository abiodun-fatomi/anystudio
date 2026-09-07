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
 *
 * THE TOMBSTONE
 * -------------
 * That refusal is not limited to jobs still waiting. `add` with an id that
 * already exists ANYWHERE — including the completed and failed sets, which
 * we keep for an hour and a day — returns the old job and creates nothing,
 * silently. And a generation is enqueued under its id more than once by
 * design:
 *
 *   · an ad's PARENT runs twice — once to plan and dispatch the shots, then
 *     again to stitch them — and the second enqueue landed on the first
 *     run's completed job;
 *   · a retry re-enqueues the same row after a failure, onto its own
 *     failed job.
 *
 * Both were dropped on the floor. What that looked like in the log was a
 * parent stuck at `waiting` with every shot finished, the dispatcher
 * cheerfully re-queuing it every twenty seconds — "dispatcher woke parents
 * whose shots had all finished", over and over — until the sweeper gave up
 * and refunded an ad whose shots had all been paid for and rendered.
 *
 * So a finished job is cleared before the add. One that is still waiting or
 * running is left exactly where it is, which is what keeps a double enqueue
 * from making two jobs.
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { QUEUES, queueFor, type Capability, type GenerationJob, type QueueName } from '@anystudio/shared';
import { createRedis } from '../../../config/redis';
import { logger } from '../../../config/logger';

/** How long a request may wait on Redis before it stops waiting. */
const ENQUEUE_TIMEOUT_MS = 3_000;

/**
 * And how long the tombstone check may take of that.
 *
 * Clearing a finished job matters, but it is housekeeping: the request has
 * already succeeded and the credits are already held. Given the same three
 * seconds as the add, a Redis outage would cost every enqueue six seconds
 * instead of three — the fail-safe this file is built around, halved by the
 * fix to a different bug. It gets a small share, and the add keeps the rest.
 */
const CLEAR_TIMEOUT_MS = 500;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not complete within ${ms}ms (redis unreachable?)`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Is this job over — a tombstone rather than work?
 *
 * BullMQ's own state names, kept in one place because the answer decides
 * whether a row can be enqueued again. `unknown` is what it returns for a
 * job that vanished between the read and the question; treat it as gone,
 * since there is nothing left to remove either way.
 */
export function isFinished(state: string): boolean {
  return state === 'completed' || state === 'failed';
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
      // See THE TOMBSTONE above: an earlier run's finished job would swallow
      // this add without a word.
      await this.clearFinishedJob(q, generationId);
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

  /**
   * Drop a job for this id that has already finished, so the add that
   * follows is not mistaken for a duplicate of it.
   *
   * Only the finished states. A job that is waiting, delayed or being run
   * right now is the very duplicate the shared id exists to prevent, and
   * removing it would either lose queued work or orphan a running one.
   *
   * Best-effort throughout: this runs on the request path, and a generation
   * that fails to shed its tombstone is no worse off than before.
   */
  private async clearFinishedJob(q: Queue<GenerationJob>, jobId: string): Promise<void> {
    try {
      const existing = await withTimeout(q.getJob(jobId), CLEAR_TIMEOUT_MS, 'getJob');
      if (!existing) return;
      const state = await withTimeout(existing.getState(), CLEAR_TIMEOUT_MS, 'getState');
      if (!isFinished(state)) return;
      await withTimeout(existing.remove(), CLEAR_TIMEOUT_MS, 'remove');
      logger.debug({ generationId: jobId, state }, 'cleared a finished queue job so this row can run again');
    } catch (err) {
      logger.debug({ generationId: jobId, err: err instanceof Error ? err.message : err }, 'could not clear the previous queue job');
    }
  }

  /** Queue depths for the operations dashboard; zeros when Redis is away. */
  async depths(): Promise<Record<QueueName, { waiting: number; active: number; failed: number } | null>> {
    const out = {} as Record<QueueName, { waiting: number; active: number; failed: number } | null>;
    for (const name of Object.values(QUEUES)) {
      const q = this.queues.get(name);
      try {
        out[name] = q
          ? await withTimeout(q.getJobCounts('waiting', 'active', 'failed'), ENQUEUE_TIMEOUT_MS, 'depths').then((c) => ({
              waiting: c.waiting ?? 0,
              active: c.active ?? 0,
              failed: c.failed ?? 0,
            }))
          : null;
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
