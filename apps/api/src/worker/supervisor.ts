/**
 * The supervisor: consumers, timers, and the plan for when Redis is gone.
 *
 * NORMAL OPERATION
 * ----------------
 * Two BullMQ workers, one per queue, with separate concurrency: images and
 * text on media.fast (many at once, seconds each), video and audio on
 * media.heavy (a couple at once, minutes each). A job is a generation id;
 * the runner does the rest.
 *
 * TWO TIMERS THAT KEEP THE PROMISES
 * ---------------------------------
 *   the sweeper     fails and refunds anything RUNNING without a heartbeat
 *                   or QUEUED for far too long — the "a failed generation
 *                   gives the credits straight back" promise
 *   the dispatcher  re-queues QUEUED rows that have no job behind them —
 *                   an enqueue that failed, a job Redis lost, a worker that
 *                   was down when the row was written
 *
 * WHEN REDIS IS DOWN
 * ------------------
 * The dispatcher notices its enqueues are not landing and switches to
 * running QUEUED rows straight from the database, one small batch at a
 * time, through the same runner. Throughput drops; correctness does not.
 * The runner's claim (QUEUED → RUNNING, conditional) is what stops a job
 * that Redis later replays from running the same row twice. When Redis
 * answers again the consumers pick up where they were and the direct loop
 * stands down. Every switch is one log line.
 */

import { Injectable } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { QUEUES, type GenerationJob } from '@anystudio/shared';
import { createRedis, redisHealthy } from '../../config/redis';
import { logger } from '../../config/logger';
import { GenerationService } from '../modules/generation/generation.service';
import { QueueService } from '../modules/queue/queue.service';
import { GenerationRunner } from './runner';
import { WebhookDispatcher } from '../modules/developer/webhook.dispatcher';
import { SupportService } from '../modules/support/support.service';
import { PublishingService } from '../modules/publishing/publishing.service';

const HEARTBEAT_KEY = 'worker:heartbeat';
const SWEEP_EVERY_MS = 60_000;
const DISPATCH_EVERY_MS = 20_000;
const WEBHOOK_EVERY_MS = 10_000;
/** Help chats nobody has touched for a day are closed and their transcript sent. */
const SUPPORT_SWEEP_EVERY_MS = 15 * 60_000;
/** Scheduled posts: the database is the queue, so this is a poll, not a consumer. */
const PUBLISH_EVERY_MS = 15_000;
/** Social tokens about to expire are exchanged for fresh ones. */
const TOKEN_REFRESH_EVERY_MS = 6 * 60 * 60_000;

@Injectable()
export class WorkerSupervisor {
  private readonly redis: Redis | undefined;
  private workers: Worker<GenerationJob>[] = [];
  private timers: NodeJS.Timeout[] = [];
  private directMode = false;
  private directBusy = 0;
  private stopping = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly runner: GenerationRunner,
    private readonly generations: GenerationService,
    private readonly queue: QueueService,
    private readonly webhooks: WebhookDispatcher,
    private readonly support: SupportService,
    private readonly publishing: PublishingService,
  ) {
    this.redis = createRedis('queue', 'worker-consumer');
  }

  async start(): Promise<void> {
    const fast = Number(process.env.WORKER_FAST_CONCURRENCY ?? 6);
    const heavy = Number(process.env.WORKER_HEAVY_CONCURRENCY ?? 2);

    if (this.redis) {
      this.workers = [this.consumer(QUEUES.fast, fast), this.consumer(QUEUES.heavy, heavy)];
      logger.info({ fast, heavy }, 'queue consumers started');
    } else {
      this.directMode = true;
      logger.warn('no REDIS_URL: the worker will run QUEUED rows straight from the database');
    }

    this.timers.push(setInterval(() => void this.heartbeat(), 30_000));
    this.timers.push(setInterval(() => void this.sweep(), SWEEP_EVERY_MS));
    this.timers.push(setInterval(() => void this.dispatch(), DISPATCH_EVERY_MS));
    // Outbound webhooks: due deliveries, a bounded batch, never overlapping.
    this.timers.push(setInterval(() => void this.webhooks.deliverDue(), WEBHOOK_EVERY_MS));
    this.timers.push(
      setInterval(() => void this.support.sweepIdle().catch((err: unknown) => logger.error({ err }, 'support sweep failed')), SUPPORT_SWEEP_EVERY_MS),
    );
    // Posts due to go out. Straight from the database, never through Redis:
    // a scheduled post must survive a Redis that is down or wiped.
    this.timers.push(setInterval(() => void this.publishing.runDue(), PUBLISH_EVERY_MS));
    this.timers.push(
      setInterval(
        () => void this.publishing.refreshTokens().catch((err: unknown) => logger.error({ err }, 'social token refresh failed')),
        TOKEN_REFRESH_EVERY_MS,
      ),
    );
    await this.heartbeat();
    await this.dispatch();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    // close(false): finish the jobs in hand rather than abandoning generations whose credits are held.
    await Promise.allSettled(this.workers.map((w) => w.close(false)));
    await this.redis?.quit().catch(() => undefined);
    logger.info('worker stopped cleanly');
  }

  private consumer(name: string, concurrency: number): Worker<GenerationJob> {
    const w = new Worker<GenerationJob>(
      name,
      async (job: Job<GenerationJob>) => {
        const outcome = await this.runner.run(job.data.generationId);
        return outcome;
      },
      { connection: this.redis!, concurrency, lockDuration: 120_000, stalledInterval: 60_000, maxStalledCount: 2 },
    );
    w.on('failed', (job, err) =>
      logger.error({ queue: name, jobId: job?.id, err: err.message }, 'job threw outside the runner — this is a bug, the runner handles its own failures'),
    );
    w.on('error', (err) => logger.warn({ queue: name, err: err.message }, 'consumer connection error; bullmq will reconnect'));
    w.on('stalled', (jobId) =>
      logger.warn({ queue: name, jobId }, 'job stalled; bullmq will retry it, the runner will find the row already RUNNING or terminal'),
    );
    return w;
  }

  /** Liveness: a key the healthcheck reads, or a log line when there is no Redis to write it to. */
  private async heartbeat(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(HEARTBEAT_KEY, Date.now().toString(), 'EX', 90);
    } catch {
      /* the availability story is told by createRedis */
    }
  }

  private async sweep(): Promise<void> {
    if (this.stopping) return;
    try {
      const reclaimed = await this.generations.sweepStale();
      if (reclaimed.length) logger.warn({ count: reclaimed.length }, 'sweeper refunded stale generations');
    } catch (err) {
      logger.error({ err }, 'sweeper failed');
    }
  }

  /** Re-queue orphans; when the queue is not accepting, run them here. */
  private async dispatch(): Promise<void> {
    if (this.stopping) return;
    try {
      const healthy = await redisHealthy(this.redis);
      if (healthy && this.directMode && this.redis) {
        this.directMode = false;
        logger.info('redis is back: queue consumers take over; direct mode off');
      }
      if (!healthy && !this.directMode) {
        this.directMode = true;
        logger.warn('redis unreachable: switching to direct mode — QUEUED rows run straight from the database');
      }

      if (!this.directMode) {
        await this.generations.redispatchOrphans();
        await this.generations.wakeReadyParents();
        return;
      }
      await this.runDirect();
    } catch (err) {
      logger.error({ err }, 'dispatcher failed');
    }
  }

  private async runDirect(): Promise<void> {
    const limit = Number(process.env.WORKER_DIRECT_CONCURRENCY ?? 2);
    if (this.directBusy >= limit) return;
    const rows = await this.db.generation.findMany({
      where: { status: 'QUEUED' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit - this.directBusy,
    });
    // Waiting parents whose shots are done run here too; the enqueue inside wakeReadyParents is a no-op without Redis.
    const parents = (await this.generations.wakeReadyParents()).slice(0, Math.max(0, limit - this.directBusy - rows.length)).map((id) => ({ id }));
    for (const { id } of [...rows, ...parents]) {
      this.directBusy++;
      void this.runner
        .run(id)
        .catch((err) => logger.error({ generationId: id, err }, 'direct run threw'))
        .finally(() => {
          this.directBusy--;
        });
    }
  }
}

export { QueueService };
