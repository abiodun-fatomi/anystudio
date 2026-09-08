import { Injectable } from '@nestjs/common';
import { PrismaClient, type Prisma } from '@prisma/client';
import { logger } from '../../../config/logger';
import { LedgerService } from '../ledger/ledger.service';

const ANNUAL_MONTHS = 12;
const EXISTING_KEY_BATCH = 5_000;
const PAYMENT_SCAN_BATCH = 500;

interface DueAllocation {
  subscriptionId: string;
  walletId: string;
  paymentId: string;
  planCode: string;
  credits: number;
  month: number;
  idempotencyKey: string;
}

export interface AnnualCreditTickResult {
  scanned: number;
  eligible: number;
  due: number;
  alreadyGranted: number;
  granted: number;
  errors: number;
}

/**
 * A yearly charge buys twelve monthly allowances. Month one is granted by
 * BillingService; this worker releases months 2-12 from the immutable schedule
 * persisted on that Payment. The shared Subscription clock is deliberately
 * not the source of truth: a newer renewal may advance it before an older
 * provider transaction is delivered.
 */
@Injectable()
export class AnnualCreditService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: LedgerService,
  ) {}

  async tick(now = new Date()): Promise<AnnualCreditTickResult> {
    const result: AnnualCreditTickResult = {
      scanned: 0,
      eligible: 0,
      due: 0,
      alreadyGranted: 0,
      granted: 0,
      errors: 0,
    };
    let cursor: string | undefined;
    do {
      const payments = await this.db.payment.findMany({
        where: {
          status: 'SUCCEEDED',
          kind: { in: ['SUBSCRIPTION', 'RENEWAL'] },
          interval: 'year',
          ledgerEntryId: { not: null },
          subscriptionId: { not: null },
        },
        select: {
          id: true,
          credits: true,
          updatedAt: true,
          providerPayload: true,
          subscriptionId: true,
          subscription: {
            select: {
              id: true,
              planCode: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
              workspace: { select: { wallet: { select: { id: true } } } },
            },
          },
        },
        orderBy: { id: 'asc' },
        take: PAYMENT_SCAN_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      result.scanned += payments.length;
      if (payments.length === 0) break;
      cursor = payments.at(-1)?.id;

      const allocations: DueAllocation[] = [];
      for (const payment of payments) {
        const subscription = payment.subscription;
        const walletId = subscription?.workspace.wallet?.id;
        const period = annualPaymentPeriod(payment.providerPayload, payment.updatedAt, subscription?.currentPeriodStart, subscription?.currentPeriodEnd);
        if (!subscription || !payment.subscriptionId || !walletId || payment.credits <= 0 || !period) continue;
        result.eligible += 1;
        for (const month of annualCreditMonthsDue(period.start, period.end, now)) {
          allocations.push({
            subscriptionId: payment.subscriptionId,
            walletId,
            paymentId: payment.id,
            planCode: subscription.planCode,
            credits: payment.credits,
            month,
            idempotencyKey: annualCreditKey(payment.id, month),
          });
        }
      }
      result.due += allocations.length;

      const existing = new Set<string>();
      for (let offset = 0; offset < allocations.length; offset += EXISTING_KEY_BATCH) {
        const keys = allocations.slice(offset, offset + EXISTING_KEY_BATCH).map((allocation) => allocation.idempotencyKey);
        const rows = await this.db.ledgerEntry.findMany({
          where: { idempotencyKey: { in: keys } },
          select: { walletId: true, idempotencyKey: true },
        });
        for (const row of rows) existing.add(`${row.walletId}:${row.idempotencyKey}`);
      }

      for (const allocation of allocations) {
        if (existing.has(`${allocation.walletId}:${allocation.idempotencyKey}`)) {
          result.alreadyGranted += 1;
          continue;
        }
        try {
          const granted = await this.db.$transaction(async (tx) => {
            // Refund finalization takes this same payment-row lock. Whichever
            // arrives first wins: the refund claws this allowance, or this
            // recheck sees that its funding Payment is no longer SUCCEEDED.
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "payments" WHERE "id" = CAST(${allocation.paymentId} AS uuid) FOR UPDATE
            `;
            const stillFunded = await tx.payment.findFirst({
              where: {
                id: allocation.paymentId,
                status: 'SUCCEEDED',
                subscriptionId: allocation.subscriptionId,
                interval: 'year',
                kind: { in: ['SUBSCRIPTION', 'RENEWAL'] },
              },
              select: { id: true },
            });
            if (!stillFunded) return false;
            const already = await tx.ledgerEntry.findUnique({
              where: { walletId_idempotencyKey: { walletId: allocation.walletId, idempotencyKey: allocation.idempotencyKey } },
              select: { id: true },
            });
            if (already) return false;
            await this.ledger.purchase(
              {
                walletId: allocation.walletId,
                amount: allocation.credits,
                idempotencyKey: allocation.idempotencyKey,
                referenceId: allocation.paymentId,
                reason: `${allocation.planCode} annual plan allowance, month ${allocation.month} of ${ANNUAL_MONTHS}`,
              },
              tx,
            );
            return true;
          });
          if (granted) result.granted += 1;
          else result.alreadyGranted += 1;
        } catch (err) {
          result.errors += 1;
          logger.error(
            {
              err,
              paymentId: allocation.paymentId,
              walletId: allocation.walletId,
              plan: allocation.planCode,
              month: allocation.month,
            },
            'annual plan credit allocation failed',
          );
        }
      }
    } while (cursor);
    return result;
  }
}

export function annualCreditKey(paymentId: string, month: number): string {
  return `payment:${paymentId}:annual-month:${month}`;
}

/** Months are calendar anniversaries of the paid period, clamped at month end. */
export function annualCreditMonthsDue(periodStart: Date, periodEnd: Date, now: Date): number[] {
  const due: number[] = [];
  for (let month = 2; month <= ANNUAL_MONTHS; month += 1) {
    const dueAt = addUtcMonthsClamped(periodStart, month - 1);
    if (dueAt.getTime() >= periodEnd.getTime() || dueAt.getTime() > now.getTime()) break;
    due.push(month);
  }
  return due;
}

type AnnualSubscriptionWindow = { start: Date; end: Date };

/** Prefer Payment.renewalTiming; use the linked clock only for legacy rows. */
function annualPaymentPeriod(
  payload: Prisma.JsonValue | null,
  paidAt: Date,
  legacyStart: Date | null | undefined,
  legacyEnd: Date | null | undefined,
): AnnualSubscriptionWindow | null {
  const root = jsonRecord(payload);
  const timing = jsonRecord(root?.renewalTiming);
  let start = validDate(timing?.periodStart) ?? validDate(timing?.occurredAt);
  let end = validDate(timing?.periodEnd);
  if (!start && legacyStart && legacyEnd && paidAt >= legacyStart && paidAt < legacyEnd) {
    start = legacyStart;
    end = legacyEnd;
  }
  if (!start) return null;
  end ??= addUtcMonthsClamped(start, ANNUAL_MONTHS);
  return end > start ? { start, end } : null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function validDate(value: unknown): Date | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function addUtcMonthsClamped(value: Date, months: number): Date {
  const target = new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth() + months,
      1,
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      value.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(value.getUTCDate(), lastDay));
  return target;
}
