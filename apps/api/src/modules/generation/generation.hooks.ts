/**
 * What happens after a generation finishes, beyond the row.
 *
 * The web studio learns through the event stream. Two other channels need
 * a push: an organization's webhook endpoint, and a WhatsApp conversation
 * waiting for its picture. Rather than have GenerationService know about
 * either, it announces here and the channels subscribe at module start.
 *
 * Listeners run after the row is terminal and are never awaited by the
 * caller: a slow webhook must not hold a worker slot, and a listener that
 * throws is logged, not propagated — the generation is already done.
 */
import { Injectable } from '@nestjs/common';
import type { Generation } from '@prisma/client';
import { logger } from '../../../config/logger';

export type GenerationListener = (row: Generation) => Promise<void> | void;

@Injectable()
export class GenerationHooks {
  private readonly listeners: GenerationListener[] = [];

  onFinished(listener: GenerationListener): void {
    this.listeners.push(listener);
  }

  /** Listeners still running. A test awaits `drain()` instead of sleeping; the app never waits. */
  private readonly inFlight = new Set<Promise<void>>();

  finished(row: Generation): void {
    for (const l of this.listeners) {
      const p: Promise<void> = Promise.resolve()
        .then(() => l(row))
        .catch((err) => logger.error({ err, generationId: row.id, channel: row.channel }, 'a generation listener failed'))
        .finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
  }

  /** Resolves once every listener started so far has finished. For tests. */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }
}
