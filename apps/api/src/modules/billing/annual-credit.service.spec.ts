import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { LedgerService } from '../ledger/ledger.service';
import { AnnualCreditService, annualCreditKey, annualCreditMonthsDue } from './annual-credit.service';

const paymentId = '11111111-1111-4111-8111-111111111111';
const walletId = '22222222-2222-4222-8222-222222222222';
const subscriptionId = '33333333-3333-4333-8333-333333333333';

function annualPayment(
  overrides: {
    id?: string;
    periodStart?: Date;
    periodEnd?: Date;
    paidAt?: Date;
    credits?: number;
    walletId?: string | null;
    providerPayload?: unknown;
    legacyPeriodStart?: Date;
    legacyPeriodEnd?: Date;
  } = {},
) {
  const periodStart = overrides.periodStart ?? new Date('2026-01-15T10:00:00.000Z');
  const periodEnd = overrides.periodEnd ?? new Date('2027-01-15T10:00:00.000Z');
  return {
    id: overrides.id ?? paymentId,
    credits: overrides.credits ?? 600,
    updatedAt: overrides.paidAt ?? new Date(periodStart.getTime() + 1_000),
    providerPayload:
      overrides.providerPayload === undefined
        ? {
            renewalTiming: {
              occurredAt: periodStart.toISOString(),
              periodStart: periodStart.toISOString(),
              periodEnd: periodEnd.toISOString(),
            },
          }
        : overrides.providerPayload,
    subscriptionId,
    subscription: {
      id: subscriptionId,
      planCode: 'creator',
      currentPeriodStart: overrides.legacyPeriodStart ?? periodStart,
      currentPeriodEnd: overrides.legacyPeriodEnd ?? periodEnd,
      workspace: { wallet: overrides.walletId === null ? null : { id: overrides.walletId ?? walletId } },
    },
  };
}

function harness(payments = [annualPayment()], existing: Array<{ walletId: string; idempotencyKey: string }> = []) {
  const purchase = vi.fn().mockResolvedValue({});
  const findManyPayments = vi.fn(async (args: { cursor?: { id: string } }) => (args.cursor ? [] : payments));
  const db: Record<string, unknown> = {
    payment: {
      findMany: findManyPayments,
      findFirst: vi.fn().mockResolvedValue({ id: paymentId }),
    },
    ledgerEntry: { findMany: vi.fn().mockResolvedValue(existing), findUnique: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: paymentId }]),
  };
  db.$transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db));
  const service = new AnnualCreditService(db as unknown as PrismaClient, { purchase } as unknown as LedgerService);
  return { service, db, purchase, findManyPayments };
}

describe('AnnualCreditService', () => {
  it('catches up every monthly allowance due after month 1 with payment-scoped keys', async () => {
    const { service, purchase, findManyPayments } = harness();
    const result = await service.tick(new Date('2026-04-15T10:00:00.000Z'));

    expect(findManyPayments).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'SUCCEEDED',
          kind: { in: ['SUBSCRIPTION', 'RENEWAL'] },
          interval: 'year',
          ledgerEntryId: { not: null },
        }),
        orderBy: { id: 'asc' },
      }),
    );
    expect(purchase.mock.calls.map(([move]) => move.idempotencyKey)).toEqual([
      annualCreditKey(paymentId, 2),
      annualCreditKey(paymentId, 3),
      annualCreditKey(paymentId, 4),
    ]);
    expect(purchase).toHaveBeenCalledWith(
      expect.objectContaining({ walletId, amount: 600, referenceId: paymentId, idempotencyKey: annualCreditKey(paymentId, 2) }),
      expect.anything(),
    );
    expect(result).toEqual({ scanned: 1, eligible: 1, due: 3, alreadyGranted: 0, granted: 3, errors: 0 });
  });

  it('skips allowances that already have ledger entries', async () => {
    const { service, purchase } = harness([annualPayment()], [{ walletId, idempotencyKey: annualCreditKey(paymentId, 2) }]);
    const result = await service.tick(new Date('2026-03-15T10:00:00.000Z'));

    expect(purchase).toHaveBeenCalledTimes(1);
    expect(purchase).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: annualCreditKey(paymentId, 3) }), expect.anything());
    expect(result).toMatchObject({ due: 2, alreadyGranted: 1, granted: 1, errors: 0 });
  });

  it('does not map a legacy payment onto a newer mutable subscription period', async () => {
    const payment = annualPayment({
      paidAt: new Date('2025-01-15T10:00:01.000Z'),
      providerPayload: {},
      legacyPeriodStart: new Date('2026-01-15T10:00:00.000Z'),
      legacyPeriodEnd: new Date('2027-01-15T10:00:00.000Z'),
    });
    const { service, db, purchase } = harness([payment]);
    const result = await service.tick(new Date('2026-04-15T10:00:00.000Z'));

    expect(purchase).not.toHaveBeenCalled();
    expect((db.ledgerEntry as { findMany: ReturnType<typeof vi.fn> }).findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, eligible: 0, due: 0, granted: 0 });
  });

  it('keeps each out-of-order annual renewal on its own immutable schedule', async () => {
    const olderId = '00000000-0000-4000-8000-000000000001';
    const newerId = '00000000-0000-4000-8000-000000000002';
    const payments = [
      annualPayment({
        id: olderId,
        periodStart: new Date('2025-01-15T10:00:00.000Z'),
        periodEnd: new Date('2026-01-15T10:00:00.000Z'),
        paidAt: new Date('2026-03-01T00:00:00.000Z'),
        legacyPeriodStart: new Date('2026-01-15T10:00:00.000Z'),
        legacyPeriodEnd: new Date('2027-01-15T10:00:00.000Z'),
      }),
      annualPayment({ id: newerId }),
    ];
    const { service, purchase } = harness(payments);

    const result = await service.tick(new Date('2026-04-15T10:00:00.000Z'));

    expect(purchase.mock.calls.map(([move]) => move.idempotencyKey)).toEqual([
      ...Array.from({ length: 11 }, (_, index) => annualCreditKey(olderId, index + 2)),
      annualCreditKey(newerId, 2),
      annualCreditKey(newerId, 3),
      annualCreditKey(newerId, 4),
    ]);
    expect(result).toMatchObject({ scanned: 2, eligible: 2, due: 14, granted: 14, errors: 0 });
  });

  it('rechecks the payment under lock and does not grant after a concurrent refund', async () => {
    const { service, db, purchase } = harness();
    (db.payment as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mockResolvedValue(null);

    const result = await service.tick(new Date('2026-02-15T10:00:00.000Z'));

    expect(db.$queryRaw).toHaveBeenCalled();
    expect(purchase).not.toHaveBeenCalled();
    expect(result.granted).toBe(0);
  });

  it('uses calendar-month anniversaries, clamps month-end, and stops at the paid-period boundary', () => {
    const start = new Date('2026-01-31T10:00:00.000Z');
    expect(annualCreditMonthsDue(start, new Date('2027-01-31T10:00:00.000Z'), new Date('2026-02-28T09:59:59.999Z'))).toEqual([]);
    expect(annualCreditMonthsDue(start, new Date('2027-01-31T10:00:00.000Z'), new Date('2026-02-28T10:00:00.000Z'))).toEqual([2]);
    expect(annualCreditMonthsDue(new Date('2026-01-15T10:00:00.000Z'), new Date('2026-06-15T10:00:00.000Z'), new Date('2026-12-01T00:00:00.000Z'))).toEqual([
      2, 3, 4, 5,
    ]);
    expect(annualCreditMonthsDue(new Date('2026-01-15T10:00:00.000Z'), new Date('2027-01-15T10:00:00.000Z'), new Date('2026-12-15T10:00:00.000Z'))).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it('is credit-idempotent when two worker services run the same tick concurrently', async () => {
    const seen = new Set([`payment:${paymentId}`]);
    let balance = 600;
    const payments = [annualPayment()];
    const db: Record<string, unknown> = {
      payment: {
        findMany: vi.fn(async (args: { cursor?: { id: string } }) => (args.cursor ? [] : payments)),
        findFirst: vi.fn().mockResolvedValue({ id: paymentId }),
      },
      // Both workers may observe a key as absent. ledger_apply remains the
      // authority, modeled here by applying each stable key once.
      ledgerEntry: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: paymentId }]),
    };
    db.$transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db));
    const purchase = vi.fn(async (move: { amount: number; idempotencyKey: string }) => {
      if (!seen.has(move.idempotencyKey)) {
        seen.add(move.idempotencyKey);
        balance += move.amount;
      }
      return {};
    });
    const service = new AnnualCreditService(db as unknown as PrismaClient, { purchase } as unknown as LedgerService);

    await Promise.all([service.tick(new Date('2026-04-15T10:00:00.000Z')), service.tick(new Date('2026-04-15T10:00:00.000Z'))]);

    expect(purchase).toHaveBeenCalledTimes(6);
    expect(new Set(purchase.mock.calls.map(([move]) => move.idempotencyKey))).toEqual(
      new Set([annualCreditKey(paymentId, 2), annualCreditKey(paymentId, 3), annualCreditKey(paymentId, 4)]),
    );
    expect(balance).toBe(2_400);
  });
});
