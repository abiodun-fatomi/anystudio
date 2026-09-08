/**
 * The supervisor: consumers, timers, and the plan for when Redis is gone.
 *
 * NORMAL OPERATION
 * ----------------
 * A configured subset of three BullMQ queues, each with separate concurrency.
 * The split is by what a slot actually costs us: images and text on media.fast
 * (many at once, seconds each); video and audio on media.heavy, where a slot is
 * a socket waiting on a vendor and so runs wide; stitching on media.local,
 * which is ffmpeg burning our own CPU and stays capped. Production runs the
 * first two on the main worker and media.local on the dedicated media worker.
 * A job is a generation id; the runner does the rest.
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
import { CAPABILITIES, QUEUES, queueFor, type Capability, type GenerationJob } from '@anystudio/shared';
import { createRedis, redisHealthy } from '../../config/redis';
import { logger } from '../../config/logger';
import { memoryMb } from '../../config/media-runtime';
import { GenerationService } from '../modules/generation/generation.service';
import { QueueService } from '../modules/queue/queue.service';
import { hostname } from 'node:os';
import { GenerationRunner } from './runner';
import { WebhookDispatcher } from '../modules/developer/webhook.dispatcher';
import { SupportService } from '../modules/support/support.service';
import { PublishingService } from '../modules/publishing/publishing.service';
import { UsageBillingService } from '../modules/usage-billing/usage-billing.service';
import { CatalogueService } from '../modules/catalogue/catalogue.service';
import { RetentionService } from '../modules/retention/retention.service';
import { AnnualCreditService } from '../modules/billing/annual-credit.service';
import { BillingService } from '../modules/billing/billing.service';

export const workerHeartbeatKey = (service: string, host = hostname()): string => `worker:heartbeat:${service}:${host}`;
export const runsGlobalSchedulers = (service: string): boolean => service === 'worker';

/** Preserve the BullMQ queue boundary when Redis is unavailable. */
export function capabilitiesForQueues(wanted: readonly string[]): Capability[] {
  const serves = (queue: string) => wanted.length === 0 || wanted.includes(queue);
  return CAPABILITIES.filter((capability) => serves(queueFor(capability)));
}

/**
 * A production worker must serve exactly its assigned queue class. Typos and
 * an unset value are fatal: the former drains nothing and the latter silently
 * collapses ffmpeg back onto the small main worker.
 */
export function workerConfigurationError(service: string, wanted: readonly string[]): string | null {
  const actual = [...new Set(wanted)].sort();
  const expected = service === 'worker' ? [QUEUES.fast, QUEUES.heavy].sort() : service === 'media' ? [QUEUES.local] : null;
  if (!expected) return `SERVICE_NAME must be "worker" or "media", received "${service}"`;
  if (actual.length !== expected.length || actual.some((queue, index) => queue !== expected[index])) {
    return `${service} must set WORKER_QUEUES=${expected.join(',')}; received ${actual.join(',') || '(unset)'}`;
  }
  return null;
}

/**
 * When to stop logging memory quietly and start complaining, in MB.
 *
 * A Render starter worker has 512 MB and is killed at it, so 400 leaves
 * enough room to see the climb before the restart rather than after. Set
 * WORKER_MEMORY_WARN_MB when the instance size changes; the number here is
 * the floor, not a law.
 */
const HIGH_WATER_MB = Number(process.env.WORKER_MEMORY_WARN_MB ?? 400);
const SWEEP_EVERY_MS = 60_000;
const DISPATCH_EVERY_MS = 20_000;
const WEBHOOK_EVERY_MS = 10_000;
/** Help chats nobody has touched for a day are closed and their transcript sent. */
const SUPPORT_SWEEP_EVERY_MS = 15 * 60_000;
/** Scheduled posts: the database is the queue, so this is a poll, not a consumer. */
const METRICS_EVERY_MS = 15 * 60_000;
const PUBLISH_EVERY_MS = 15_000;
/** Social tokens about to expire are exchanged for fresh ones. */
const TOKEN_REFRESH_EVERY_MS = 6 * 60 * 60_000;
/** Invoicing and annual-plan monthly allowances. Hourly is plenty; the first run happens at start so downtime is caught up immediately. */
const BILLING_EVERY_MS = 60 * 60_000;
/** Verified payment webhooks are a durable database queue; recover a crashed API claim promptly. */
const BILLING_RECOVERY_EVERY_MS = 60_000;
/** Connected stores are re-read every few hours; this is how often the worker looks for one that is due. */
const CATALOGUE_EVERY_MS = 5 * 60_000;
/** The privacy policy's clocks tick in days; four passes a day keeps every promise within hours of due. */
const RETENTION_EVERY_MS = 6 * 60 * 60_000;
const SCHEDULER_LOCK_TIMEOUT_MS = 30 * 60_000;

/**
 * Hold a transaction-scoped Postgres advisory lock for the whole scheduler
 * pass. Role separation prevents the normal duplicate; this lock also makes
 * a second replica, a rolling deploy overlap, or an accidental duplicate
 * service safe. Process death closes the transaction and releases the lock.
 */
export async function runWithSchedulerLock(db: PrismaClient, name: string, task: () => Promise<unknown>): Promise<boolean> {
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`anystudio:scheduler:${name}`}, 0)) AS acquired
      `;
      if (!rows[0]?.acquired) return false;
      await task();
      return true;
    },
    { maxWait: 2_000, timeout: SCHEDULER_LOCK_TIMEOUT_MS },
  );
}

@Injectable()
export class WorkerSupervisor {
  private readonly redis: Redis | undefined;
  private workers: Worker<GenerationJob>[] = [];
  private timers: NodeJS.Timeout[] = [];
  private directMode = false;
  private directBusy = 0;
  /** The database fallback must preserve the same queue boundary as BullMQ. */
  private directCapabilities: Capability[] = [...CAPABILITIES];
  private stopping = false;
  private readonly serviceName = process.env.SERVICE_NAME?.trim() || 'worker';

  constructor(
    private readonly db: PrismaClient,
    private readonly runner: GenerationRunner,
    private readonly generations: GenerationService,
    private readonly queue: QueueService,
    private readonly webhooks: WebhookDispatcher,
    private readonly support: SupportService,
    private readonly publishing: PublishingService,
    private readonly usageBilling: UsageBillingService,
    private readonly billing: BillingService,
    private readonly annualCredits: AnnualCreditService,
    private readonly catalogue: CatalogueService,
    private readonly retention: RetentionService,
  ) {
    this.redis = createRedis('queue', 'worker-consumer');
  }

  async start(): Promise<void> {
    const fast = Number(process.env.WORKER_FAST_CONCURRENCY ?? 6);
    // Heavy work waits on a vendor rather than on this box, so the slots are
    // cheap: four shots of one ad should render side by side, not two by two.
    const heavy = Number(process.env.WORKER_HEAVY_CONCURRENCY ?? 8);
    // Stitching is ffmpeg here; that one really does need a core.
    const local = Number(process.env.WORKER_LOCAL_CONCURRENCY ?? 2);

    /**
     * WHICH queues this process serves — the setting that lets one image run
     * as two differently-sized services.
     *
     * The three queues are not the same kind of work. `fast` and `heavy` are
     * sockets waiting on a vendor: nearly free in memory, and they want lots
     * of slots. `local` is ffmpeg on this box, and a single 30-second stitch
     * peaks at hundreds of megabytes.
     *
     * Running both in one 512 MB process is what took the worker down
     * mid-stitch, and it took every other generation in flight with it —
     * because ffmpeg is a child, its memory never appeared in our rss, and
     * nothing in the process could see the wall coming. It also forced the
     * concurrency down for everyone: four shots of an ad now render two by
     * two on a box sized for the encoder rather than for the waiting.
     *
     * WORKER_QUEUES splits them. Deploy the same image twice —
     *   WORKER_QUEUES=media.fast,media.heavy   small box, many slots
     *   WORKER_QUEUES=media.local              bigger box, one slot
     * — and a stitch that overruns kills only the encoder's own service,
     * where the sweeper refunds its one ad. Unset, every queue is served, so
     * a single-service deployment behaves exactly as before.
     */
    const wanted = (process.env.WORKER_QUEUES ?? '')
      .split(',')
      .map((q) => q.trim())
      .filter(Boolean);
    const serves = (q: string) => wanted.length === 0 || wanted.includes(q);
    const unknown = wanted.filter((q) => !Object.values(QUEUES).includes(q as (typeof QUEUES)[keyof typeof QUEUES]));
    const configurationError = workerConfigurationError(this.serviceName, wanted);
    if (process.env.NODE_ENV === 'production' && configurationError) throw new Error(`Unsafe worker configuration: ${configurationError}`);
    if (unknown.length) logger.warn({ unknown, known: Object.values(QUEUES) }, 'WORKER_QUEUES names a queue that does not exist; it will serve nothing');
    this.directCapabilities = capabilitiesForQueues(wanted);

    if (this.redis) {
      this.workers = [
        ...(serves(QUEUES.fast) ? [this.consumer(QUEUES.fast, fast)] : []),
        ...(serves(QUEUES.heavy) ? [this.consumer(QUEUES.heavy, heavy)] : []),
        ...(serves(QUEUES.local) ? [this.consumer(QUEUES.local, local)] : []),
      ];
      if (this.workers.length === 0) logger.error({ wanted }, 'WORKER_QUEUES matched no queue: this process will consume nothing');
      logger.info(
        { queues: this.workers.length, fast: serves(QUEUES.fast) ? fast : 0, heavy: serves(QUEUES.heavy) ? heavy : 0, local: serves(QUEUES.local) ? local : 0 },
        'queue consumers started',
      );
    } else {
      this.directMode = true;
      logger.warn('no REDIS_URL: the worker will run QUEUED rows straight from the database');
    }

    this.timers.push(setInterval(() => void this.heartbeat(), 30_000));
    this.schedule('generation-sweep', SWEEP_EVERY_MS, () => this.sweep());
    // Both queue roles must recover their own Redis-down rows, while a second
    // replica of either role must not run the same recovery pass concurrently.
    this.schedule(`generation-dispatch:${this.serviceName}`, DISPATCH_EVERY_MS, () => this.dispatch());
    // The media process is a queue consumer, not a second cron host. Running
    // these on both services can duplicate external side effects (especially
    // outbound webhook POSTs, whose in-flight guard is process-local).
    if (runsGlobalSchedulers(this.serviceName)) {
      // Outbound webhooks: due deliveries, a bounded batch, never overlapping.
      this.schedule('webhook-delivery', WEBHOOK_EVERY_MS, () => this.webhooks.deliverDue());
      this.schedule('support-sweep', SUPPORT_SWEEP_EVERY_MS, () => this.support.sweepIdle());
      // Posts due to go out. Straight from the database, never through Redis:
      // a scheduled post must survive a Redis that is down or wiped.
      this.schedule('publishing-due', PUBLISH_EVERY_MS, () => this.publishing.runDue());
      this.schedule('publishing-token-refresh', TOKEN_REFRESH_EVERY_MS, () => this.publishing.refreshTokens());
      // How the posts are doing: the youngest hourly, the rest every six hours; the tick itself runs often and skips what is fresh.
      this.schedule('publishing-metrics', METRICS_EVERY_MS, () => this.publishing.refreshMetrics());
      this.schedule('billing', BILLING_EVERY_MS, () => this.billingTick());
      this.schedule('billing-recovery', BILLING_RECOVERY_EVERY_MS, () => this.billingRecoveryTick());
      this.schedule('catalogue-sync', CATALOGUE_EVERY_MS, () => this.catalogue.syncDue());
      this.schedule('retention', RETENTION_EVERY_MS, () => this.retention.run());
    } else {
      logger.info({ service: this.serviceName }, 'global schedulers disabled on queue-only worker');
    }
    await this.heartbeat();
    await this.runScheduled(`generation-dispatch:${this.serviceName}`, () => this.dispatch());
    if (runsGlobalSchedulers(this.serviceName)) {
      void this.runScheduled('billing', () => this.billingTick());
      void this.runScheduled('billing-recovery', () => this.billingRecoveryTick());
      void this.runScheduled('retention', () => this.retention.run());
    }
  }

  private schedule(name: string, everyMs: number, task: () => Promise<unknown>): void {
    this.timers.push(setInterval(() => void this.runScheduled(name, task), everyMs));
  }

  private async runScheduled(name: string, task: () => Promise<unknown>): Promise<void> {
    try {
      const acquired = await runWithSchedulerLock(this.db, name, task);
      if (!acquired) logger.debug({ scheduler: name }, 'scheduler pass skipped: another worker holds the lease');
    } catch (err) {
      logger.error({ err, scheduler: name }, 'scheduler pass failed');
    }
  }

  private async billingTick(): Promise<void> {
    try {
      const r = await this.usageBilling.tick();
      if (r.closed || r.overdue || r.suspended || r.warned) logger.info(r, 'billing tick');
    } catch (err) {
      logger.error({ err }, 'billing tick failed');
    }
    try {
      const r = await this.annualCredits.tick();
      if (r.granted || r.errors) logger[r.errors ? 'error' : 'info'](r, 'annual plan credit tick');
    } catch (err) {
      logger.error({ err }, 'annual plan credit tick failed');
    }
  }

  private async billingRecoveryTick(): Promise<void> {
    try {
      const r = await this.billing.maintenanceTick();
      if (r.receipts || r.subscriptionsEnded) logger[r.failed ? 'error' : 'info'](r, 'billing recovery tick');
    } catch (err) {
      logger.error({ err }, 'billing recovery tick failed');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    // close(false): finish the jobs in hand rather than abandoning generations whose credits are held.
    await Promise.allSettled(this.workers.map((w) => w.close(false)));
    await this.redis?.quit().catch(() => undefined);
    logger.info('worker stopped cleanly');
  }

  /** Jobs being processed right now, across every queue. Reported with memory. */
  private inFlight = 0;

  private consumer(name: string, concurrency: number): Worker<GenerationJob> {
    const w = new Worker<GenerationJob>(
      name,
      async (job: Job<GenerationJob>) => {
        this.inFlight += 1;
        try {
          return await this.runner.run(job.data.generationId);
        } finally {
          this.inFlight -= 1;
        }
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

  /**
   * Liveness, told two ways: a Redis key the healthcheck reads, and a row in
   * Postgres the staff console reads — so "is a worker running?" has an
   * answer even when Redis is down or absent.
   */
  private readonly startedAt = new Date();
  private readonly heartbeatId = `${this.serviceName}@${hostname()}`;

  private async heartbeat(): Promise<void> {
    const now = new Date();
    if (this.redis) {
      try {
        await this.redis.set(workerHeartbeatKey(this.serviceName, hostname()), now.getTime().toString(), 'EX', 90);
      } catch {
        /* the availability story is told by createRedis */
      }
    }
    try {
      const version = process.env.GIT_SHA ?? process.env.RENDER_GIT_COMMIT ?? null;
      await this.db.workerHeartbeat.upsert({
        where: { id: this.heartbeatId },
        create: { id: this.heartbeatId, service: this.serviceName, host: hostname(), version, startedAt: this.startedAt, seenAt: now },
        // A platform may reuse a hostname after a process restart. Refreshing
        // startedAt keeps this row an identity for the current process rather
        // than making an old process appear to have survived the restart.
        update: { service: this.serviceName, host: hostname(), startedAt: this.startedAt, seenAt: now, version },
      });
    } catch (err) {
      logger.warn({ err }, 'could not record the worker heartbeat');
    }

    // What the process is actually holding, every thirty seconds.
    //
    // The worker was OOM-killed with nothing in the log but the kill, which
    // left the shape of the growth to guesswork: a JavaScript leak climbs in
    // `heap`, buffered media climbs in `external` and `buffers`, and a
    // native allocator that never gives pages back climbs in `rss` alone
    // while the other three stay flat. One line at DEBUG tells them apart,
    // and it is the first thing to read after the next restart.
    const mem = memoryMb();
    // Judge on the CONTAINER when the kernel will tell us, because the
    // process's own rss cannot see ffmpeg, and ffmpeg is what overruns.
    const level = (mem.containerPct ?? 0) >= 80 || mem.rss >= HIGH_WATER_MB ? 'warn' : 'debug';
    logger[level](
      { ...mem, inFlight: this.inFlight },
      level === 'warn' ? 'memory is close to the container limit; jobs may be interrupted by a restart' : 'worker memory',
    );
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
        await this.generations.wakeReadyParents(this.directCapabilities);
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
      // A Redis outage must not collapse the service split. In particular, the
      // 512 MB fast/heavy worker may never claim a local stitch directly.
      where: { status: 'QUEUED', capability: { in: this.directCapabilities } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit - this.directBusy,
    });
    // Filter by the resume queue rather than by the row capability: a waiting
    // ad resumes as VIDEO_STITCH on media.local, while a waiting BATCH remains
    // BATCH on media.fast. Each Redis-down service therefore claims only its
    // own kind of parent work.
    const parents = (await this.generations.wakeReadyParents(this.directCapabilities))
      .slice(0, Math.max(0, limit - this.directBusy - rows.length))
      .map((id) => ({ id }));
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
