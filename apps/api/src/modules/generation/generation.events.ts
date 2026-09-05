/**
 * Progress events — how the studio watches a generation happen.
 *
 * The worker publishes each stage on a Redis channel AND writes it onto the
 * row. The API relays the channel to the browser over SSE. If Redis is away,
 * or the subscribe fails, or nothing has arrived for a while, the stream
 * polls the row instead — the customer sees the same truth, a couple of
 * seconds later. No fake timers, no spinner that lies.
 *
 * Every event also carries a timestamp so a late or replayed event cannot
 * move the UI backwards.
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { generationChannel, type GenerationEvent, type GenerationStage } from '@anystudio/shared';
import { createRedis } from '../../../config/redis';
import { logger } from '../../../config/logger';

/** How often the fallback looks at the row when no event has arrived. */
const POLL_MS = 2_500;
/** A stream older than this is closed; the client reconnects with Last-Event-ID semantics. */
const MAX_STREAM_MS = 10 * 60 * 1000;

@Injectable()
export class GenerationEvents implements OnModuleDestroy {
  private readonly pub: Redis | undefined;
  private readonly sub: Redis | undefined;
  private readonly listeners = new Map<string, Set<(e: GenerationEvent) => void>>();

  constructor(private readonly db: PrismaClient) {
    this.pub = createRedis('general', 'events-publisher');
    this.sub = createRedis('pubsub', 'events-subscriber');
    this.sub?.on('message', (channel: string, raw: string) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      try {
        const event = JSON.parse(raw) as GenerationEvent;
        for (const fn of set) fn(event);
      } catch (err) {
        logger.warn({ channel, err }, 'unparseable generation event dropped');
      }
    });
  }

  /**
   * Publish a stage. Called by the worker. The row write is the durable half
   * and happens first; the publish is best-effort and a failure is DEBUG,
   * because the poller will deliver the same fact from the row.
   */
  async stage(generationId: string, stage: GenerationStage, progress: number, detail?: string): Promise<void> {
    await this.db.generation.updateMany({
      where: { id: generationId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { stage, progress: Math.max(0, Math.min(100, Math.round(progress))) },
    });
    await this.publish({ type: 'stage', generationId, stage, progress, detail, at: new Date().toISOString() });
  }

  async publish(event: GenerationEvent): Promise<void> {
    if (!this.pub) return;
    try {
      await this.pub.publish(generationChannel(event.generationId), JSON.stringify(event));
    } catch (err) {
      logger.debug({ generationId: event.generationId, err }, 'event publish failed; the poller will deliver it');
    }
  }

  /**
   * Subscribe to a generation's events until it reaches a terminal state.
   *
   * Yields events from Redis when it can, and synthesises them from the row
   * when it cannot — the caller never knows which. Ends with a `done` event.
   */
  async *watch(generationId: string, signal: AbortSignal): AsyncGenerator<GenerationEvent> {
    const channel = generationChannel(generationId);
    const inbox: GenerationEvent[] = [];
    let wake: (() => void) | null = null;
    const onEvent = (e: GenerationEvent) => {
      inbox.push(e);
      wake?.();
    };

    let subscribed = false;
    if (this.sub) {
      try {
        if (!this.listeners.has(channel)) {
          this.listeners.set(channel, new Set());
          await this.sub.subscribe(channel);
        }
        this.listeners.get(channel)!.add(onEvent);
        subscribed = true;
      } catch (err) {
        logger.warn({ generationId, err: err instanceof Error ? err.message : err }, 'event subscribe failed; polling the row instead');
      }
    }

    const startedAt = Date.now();
    let lastStage: string | null = null;
    let lastProgress = -1;
    try {
      // Always start from the row, so a reconnecting client is told where things stand now.
      const first = await this.snapshot(generationId);
      if (first) {
        yield first;
        if (first.type === 'done') return;
        if (first.type === 'stage') {
          lastStage = first.stage;
          lastProgress = first.progress;
        }
      }

      while (!signal.aborted && Date.now() - startedAt < MAX_STREAM_MS) {
        // Drain whatever Redis delivered.
        while (inbox.length) {
          const e = inbox.shift()!;
          if (e.type === 'stage') {
            lastStage = e.stage;
            lastProgress = e.progress;
          }
          yield e;
          if (e.type === 'done') return;
        }
        // Wait for the next event, or the poll interval — whichever first.
        await new Promise<void>((resolve) => {
          wake = resolve;
          const t = setTimeout(resolve, subscribed ? POLL_MS * 2 : POLL_MS);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
        wake = null;
        if (inbox.length) continue;
        // Nothing arrived: read the row. This is the fallback AND the safety net.
        const snap = await this.snapshot(generationId);
        if (!snap) return;
        if (snap.type === 'done') {
          yield snap;
          return;
        }
        if (snap.type === 'stage' && (snap.stage !== lastStage || snap.progress !== lastProgress)) {
          lastStage = snap.stage;
          lastProgress = snap.progress;
          yield snap;
        }
      }
    } finally {
      const set = this.listeners.get(channel);
      set?.delete(onEvent);
      if (set && set.size === 0) {
        this.listeners.delete(channel);
        this.sub?.unsubscribe(channel).catch(() => undefined);
      }
    }
  }

  /** The row, as an event. */
  private async snapshot(generationId: string): Promise<GenerationEvent | null> {
    const row = await this.db.generation.findUnique({
      where: { id: generationId },
      select: { status: true, stage: true, progress: true, finishedAt: true },
    });
    if (!row) return null;
    const at = new Date().toISOString();
    if (row.status === 'SUCCEEDED' || row.status === 'FAILED' || row.status === 'CANCELLED') {
      return { type: 'done', generationId, status: row.status, at };
    }
    const stage = (row.stage ?? (row.status === 'RUNNING' ? 'generating' : 'queued')) as GenerationStage;
    return { type: 'stage', generationId, stage, progress: row.progress, at };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit()]);
  }
}
