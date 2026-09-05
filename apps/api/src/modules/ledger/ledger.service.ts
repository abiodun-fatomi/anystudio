/**
 * The only way credits move.
 *
 * Every method here calls the `ledger_apply` Postgres function, which locks the
 * wallet row, checks the idempotency key under that lock, refuses overdrafts and
 * appends the entry — all in one transaction. This service adds types, error
 * mapping and the business vocabulary (debit, refund, grant); it never touches
 * `ledger_entries` directly, and nothing else in the codebase may either.
 *
 * SOLID note: this is the single responsibility "move credits, correctly".
 * Pricing (how many credits a reel costs) lives elsewhere and is passed in.
 */

import { Injectable } from '@nestjs/common';
import { PrismaClient, type LedgerEntry, type LedgerKind } from '@prisma/client';
import { InsufficientCreditsError, NotFoundError } from '../../../config/globals/errors';

/** What a caller must supply to move credits. */
export interface LedgerMove {
  walletId: string;
  /** Always positive; the method decides the sign. */
  amount: number;
  /** Unique per wallet. Reuse returns the original row rather than spending again. */
  idempotencyKey: string;
  /** The generation, payment or staff action this belongs to. */
  referenceId?: string;
  reason?: string;
}

/** The subset a staff adjustment adds. */
export interface LedgerAdjustment extends LedgerMove {
  /** Signed — an adjustment may go either way. */
  delta: number;
  actorId: string;
  /** Mandatory. An adjustment without a reason is not an audit trail. */
  reason: string;
}

/** The subset of a Prisma client (or transaction client) the ledger needs. */
export type LedgerClient = Pick<PrismaClient, '$queryRaw'>;

@Injectable()
export class LedgerService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Spend credits on a generation.
   *
   * Throws InsufficientCreditsError if the balance would go negative — the
   * caller shows the top-up screen and, crucially, keeps the user's input.
   *
   * Takes an optional transaction client so a caller can write its own row and
   * charge for it atomically. GenerationService does exactly that: a row
   * without its debit is free work, and a debit without its row is a charge
   * nobody can explain.
   */
  async debit(m: LedgerMove, tx?: LedgerClient): Promise<LedgerEntry> {
    return this.apply('DEBIT', -Math.abs(m.amount), m, undefined, tx);
  }

  /**
   * Return credits after a failed generation.
   *
   * Uses the SAME idempotency key as the debit with a suffix, so a job that is
   * retried and fails twice refunds exactly once.
   */
  async refund(m: LedgerMove): Promise<LedgerEntry> {
    return this.apply('REFUND', Math.abs(m.amount), { ...m, idempotencyKey: `${m.idempotencyKey}:refund` });
  }

  /** Credits bought, or granted by a plan renewal. */
  async purchase(m: LedgerMove): Promise<LedgerEntry> {
    return this.apply('PURCHASE', Math.abs(m.amount), m);
  }

  /** Free-tier and campaign credits. */
  async grant(m: LedgerMove, tx?: LedgerClient): Promise<LedgerEntry> {
    return this.apply('PROMO', Math.abs(m.amount), m, undefined, tx);
  }

  /** Plan credits that lapsed at period end. */
  async expire(m: LedgerMove): Promise<LedgerEntry> {
    return this.apply('EXPIRY', -Math.abs(m.amount), m);
  }

  /**
   * A staff correction. Never an edit to an existing row — a new row that
   * says what changed, by whom, and why. The policy layer has already refused
   * this if the actor belongs to the target workspace.
   */
  async adjust(a: LedgerAdjustment): Promise<LedgerEntry> {
    if (!a.reason.trim()) throw new Error('An adjustment requires a reason');
    return this.apply('ADJUSTMENT', a.delta, a, a.actorId);
  }

  /**
   * Take back credits a gateway refunded. An ADJUSTMENT with no staff actor,
   * so the row reads "refund of payment X" rather than "someone decided".
   * Refused by the database if the credits were already spent — the caller
   * records that and a person follows up; we do not push a wallet negative.
   */
  async clawback(m: LedgerMove): Promise<LedgerEntry> {
    return this.apply('ADJUSTMENT', -Math.abs(m.amount), { ...m, idempotencyKey: `${m.idempotencyKey}:clawback` });
  }

  /** Current balance, from the last row. One indexed read. */
  async balance(walletId: string): Promise<number> {
    const rows = await this.db.$queryRaw<{ balance: number }[]>`
      SELECT ledger_balance(${walletId}::uuid) AS balance`;
    return rows[0]?.balance ?? 0;
  }

  /**
   * A page of history for the customer's own ledger screen, newest first.
   * Every row shown to the user comes from here; there is no other source.
   */
  async history(walletId: string, take = 50, cursor?: string): Promise<LedgerEntry[]> {
    return this.db.ledgerEntry.findMany({
      where: { walletId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
  }

  /**
   * Drift check for the operations dashboard: nonzero means something wrote
   * around the function, which is a security finding rather than a bug.
   */
  async drift(walletId: string): Promise<number> {
    const rows = await this.db.$queryRaw<{ drift: number }[]>`
      SELECT ledger_drift(${walletId}::uuid) AS drift`;
    return rows[0]?.drift ?? 0;
  }

  /** The one call site for the Postgres function. */
  private async apply(kind: LedgerKind, delta: number, m: LedgerMove, actorId?: string, tx?: LedgerClient): Promise<LedgerEntry> {
    // A caller inside an interactive transaction (registration, a paid
    // top-up that also records the payment) passes its client so the ledger
    // row commits or rolls back with everything else. Default: our own.
    const client = tx ?? this.db;
    try {
      const rows = await client.$queryRaw<LedgerEntry[]>`
        SELECT * FROM ledger_apply(
          ${m.walletId}::uuid, ${kind}::"LedgerKind", ${delta}::int,
          ${m.idempotencyKey}, ${m.referenceId ?? null}::uuid, ${m.reason ?? null}, ${actorId ?? null}::uuid
        )`;
      const row = rows[0];
      if (!row) throw new Error('ledger_apply returned no row');
      return row;
    } catch (err) {
      const code = (err as { code?: string; meta?: { code?: string } })?.meta?.code ?? (err as { code?: string })?.code;
      if (code === 'AS001') throw new InsufficientCreditsError();
      if (code === '23503') throw new NotFoundError('wallet');
      throw err;
    }
  }
}
