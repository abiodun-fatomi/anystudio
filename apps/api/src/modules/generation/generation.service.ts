/**
 * The lifecycle of a generation, and the money attached to it.
 *
 * THE ORDERING THAT MATTERS
 * -------------------------
 * `request()` writes the row and debits the credits in ONE transaction, before
 * anything is queued and long before a provider is called. Everything after
 * that is a state transition on a row that already exists and is already paid
 * for. The queue carries an id and nothing else.
 *
 * Do it the other way round — queue first, charge later — and every failure
 * between the two becomes a customer who was charged for nothing, or a
 * generation nobody paid for. Neither is recoverable from the outside, because
 * there is no record of what was supposed to happen.
 *
 * CREDITS ARE HELD, NOT SPENT
 * ---------------------------
 * The debit is a reservation. `fail()` and `cancel()` refund it; `succeed()`
 * simply lets it stand. Both go through LedgerService, which goes through the
 * `ledger_apply` Postgres function — this service never touches ledger rows.
 *
 * Refunds reuse the debit's idempotency key with a `:refund` suffix, so a
 * generation that somehow fails twice refunds exactly once.
 *
 * EVERY TRANSITION IS GUARDED
 * ---------------------------
 * A row already in a terminal state is never moved again. That is what stops
 * the two ways money leaks here: a retried failure refunding twice, and a
 * late provider success un-refunding a generation the customer was already
 * paid back for.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type Generation } from '@prisma/client';
import { generationDebitKey } from '@anystudio/shared';
import { LedgerService } from '../ledger/ledger.service';
import { ConflictError, NotFoundError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import {
  STALE_AFTER_MS,
  TERMINAL_STATUSES,
  type GenerationOutcome,
  type GenerationRequest,
  type GenerationResult,
} from './generation.types';

@Injectable()
export class GenerationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Reserve credits and record the intent.
   *
   * Throws InsufficientCreditsError (402) before anything is written, so a
   * customer who cannot afford it never gets a half-created generation. The
   * price is read from CreditCost here and COPIED onto the row — an operator
   * changing the price later must not alter what this customer was charged.
   */
  async request(req: GenerationRequest): Promise<GenerationResult> {
    const cost = await this.db.creditCost.findUnique({ where: { code: req.costCode } });
    if (!cost) throw new NotFoundError(`credit cost "${req.costCode}"`);

    const wallet = await this.db.wallet.findUnique({ where: { workspaceId: req.workspaceId } });
    if (!wallet) throw new NotFoundError('wallet');

    // One transaction: the row and the debit commit together or not at all.
    // A row without its debit is free work; a debit without its row is a
    // charge nobody can explain.
    const generation = await this.db.$transaction(async (tx) => {
      const row = await tx.generation.create({
        data: {
          workspaceId: req.workspaceId,
          requestedById: req.requestedById,
          costCode: cost.code,
          credits: cost.credits,
          input: req.input as Prisma.InputJsonObject,
        },
      });

      await this.ledger.debit(
        {
          walletId: wallet.id,
          amount: cost.credits,
          idempotencyKey: generationDebitKey(row.id),
          referenceId: row.id,
          reason: cost.label,
        },
        tx,
      );

      return row;
    });

    logger.info(
      { generationId: generation.id, workspaceId: req.workspaceId, costCode: cost.code, credits: cost.credits },
      'generation requested',
    );
    return { generation, balance: await this.ledger.balance(wallet.id) };
  }

  /**
   * A worker has picked it up.
   *
   * Conditional on the row still being QUEUED, so two workers racing the same
   * id cannot both start it — the loser gets no row back and drops the job.
   * Returns null in that case rather than throwing: losing the race is normal
   * operation, not an error.
   */
  async start(id: string, providerKey?: string): Promise<Generation | null> {
    const { count } = await this.db.generation.updateMany({
      where: { id, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        heartbeatAt: new Date(),
        attempts: { increment: 1 },
        ...(providerKey ? { providerKey } : {}),
      },
    });
    if (count === 0) return null;
    return this.db.generation.findUnique({ where: { id } });
  }

  /**
   * Still working.
   *
   * The worker calls this while it waits on the provider. Without it the
   * sweeper cannot tell a long video generation from a dead worker, and would
   * have to choose between killing honest work and never reclaiming anything.
   */
  async heartbeat(id: string): Promise<void> {
    await this.db.generation.updateMany({
      where: { id, status: 'RUNNING' },
      data: { heartbeatAt: new Date() },
    });
  }

  /** Outputs are stored. The debit stands; there is nothing to refund. */
  async succeed(id: string, outcome: GenerationOutcome): Promise<Generation> {
    const row = await this.claimTerminal(id);
    return this.db.generation.update({
      where: { id: row.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        outputs: (outcome.outputs ?? {}) as Prisma.InputJsonObject,
        ...(outcome.providerKey ? { providerKey: outcome.providerKey } : {}),
        ...(outcome.providerJobId ? { providerJobId: outcome.providerJobId } : {}),
      },
    });
  }

  /** It ended badly. Give the credits back. */
  async fail(id: string, outcome: GenerationOutcome): Promise<Generation> {
    const row = await this.claimTerminal(id);
    await this.refund(row, outcome.failureReason ?? 'generation failed');
    return this.db.generation.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        failureReason: outcome.failureReason ?? null,
        ...(outcome.providerKey ? { providerKey: outcome.providerKey } : {}),
        ...(outcome.providerJobId ? { providerJobId: outcome.providerJobId } : {}),
      },
    });
  }

  /**
   * The customer changed their mind.
   *
   * Only while QUEUED. Once a provider has been called the money is spent on
   * our side whatever the customer wants, and pretending otherwise would mean
   * refunding work we have already paid for.
   */
  async cancel(id: string): Promise<Generation> {
    const row = await this.db.generation.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('generation');
    if (row.status !== 'QUEUED') {
      throw new ConflictError('That generation has already started and cannot be cancelled.');
    }
    await this.refund(row, 'cancelled before it started');
    return this.db.generation.update({
      where: { id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
  }

  /**
   * Reclaim generations nobody is working on any more.
   *
   * This is what makes a lost Redis job survivable. Anything RUNNING whose
   * heartbeat has gone quiet, or anything QUEUED that was never picked up,
   * is failed and refunded. Run it on a schedule.
   *
   * Returns the ids it reclaimed, so the caller can log and alert on a number
   * that should normally be zero.
   */
  async sweepStale(now = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
    const stale = await this.db.generation.findMany({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] },
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, createdAt: { lt: cutoff } }],
      },
      select: { id: true },
      take: 100, // bounded: a backlog is drained over several runs, not one long lock
    });

    const reclaimed: string[] = [];
    for (const { id } of stale) {
      try {
        await this.fail(id, { failureReason: 'no worker heartbeat; reclaimed by the sweeper' });
        reclaimed.push(id);
      } catch (err) {
        // One poisoned row must not stop the others being refunded.
        logger.error({ err, generationId: id }, 'sweeper could not reclaim generation');
      }
    }
    if (reclaimed.length) logger.warn({ count: reclaimed.length, reclaimed }, 'generations reclaimed by the sweeper');
    return reclaimed;
  }

  /** The customer's history, newest first. */
  async history(workspaceId: string, take = 50, cursor?: string): Promise<Generation[]> {
    return this.db.generation.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
  }

  /**
   * Fetch a row and refuse to move it if it has already finished.
   *
   * Every terminal transition goes through here. A provider that answers twice,
   * a retried webhook, a sweeper racing a worker that just came back — all of
   * them land here and are turned away, which is what keeps the refund exactly
   * once.
   */
  private async claimTerminal(id: string): Promise<Generation> {
    const row = await this.db.generation.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('generation');
    if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
      throw new ConflictError(`That generation already ${row.status.toLowerCase()}.`);
    }
    return row;
  }

  /** Give back exactly what was taken, keyed so it can only happen once. */
  private async refund(row: Generation, reason: string): Promise<void> {
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId: row.workspaceId } });
    if (!wallet) throw new NotFoundError('wallet');
    await this.ledger.refund({
      walletId: wallet.id,
      amount: row.credits,
      idempotencyKey: generationDebitKey(row.id),
      referenceId: row.id,
      reason,
    });
  }
}
