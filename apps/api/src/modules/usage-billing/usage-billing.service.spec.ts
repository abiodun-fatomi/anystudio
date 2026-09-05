/**
 * Usage billing: the arithmetic is pure and tested as such; the close and
 * dunning loops are tested against a small in-memory database, because the
 * invariants they keep — one invoice per period, one reminder, suspension
 * closes the line and payment reopens it — are about sequencing, not SQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageBillingService } from './usage-billing.service';
import { invoiceNumber, monthOf, nextMonth, priceCredits, priceUsage } from './usage-billing.types';

describe('pricing', () => {
  it('rounds per line so the lines add up to the subtotal', () => {
    const r = priceUsage(
      [
        { costCode: 'image.storefront', label: 'Storefront image', requests: 3, credits: 30 },
        { costCode: 'text.caption', label: 'Caption', requests: 7, credits: 7 },
      ],
      125,
      0,
    );
    expect(r.lines.map((l) => l.amountMinor)).toEqual([38, 9]); // 37.5 → 38, 8.75 → 9
    expect(r.usageMinor).toBe(47);
    expect(r.credits).toBe(37);
    expect(r.totalMinor).toBe(47);
  });

  it('tops up to the monthly minimum as a separate amount, never below zero', () => {
    const r = priceUsage([{ costCode: 'x', label: 'x', requests: 1, credits: 10 }], 100, 5000);
    expect(r.usageMinor).toBe(10);
    expect(r.minimumMinor).toBe(4990);
    expect(r.totalMinor).toBe(5000);
    const refunds = priceUsage([{ costCode: 'x', label: 'x', requests: 0, credits: -40 }], 100, 0);
    expect(refunds.usageMinor).toBe(0);
    expect(refunds.totalMinor).toBe(0);
  });

  it('drops empty lines and keeps the biggest first', () => {
    const r = priceUsage(
      [
        { costCode: 'a', label: 'a', requests: 0, credits: 0 },
        { costCode: 'b', label: 'b', requests: 1, credits: 5 },
        { costCode: 'c', label: 'c', requests: 1, credits: 50 },
      ],
      100,
      0,
    );
    expect(r.lines.map((l) => l.costCode)).toEqual(['c', 'b']);
  });

  it('knows its months in UTC and names invoices by month', () => {
    const m = monthOf(new Date('2026-09-17T23:30:00Z'));
    expect(m.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(m.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(nextMonth(new Date('2026-12-01T00:00:00Z')).start.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(invoiceNumber(m.start, 7)).toBe('INV-202609-0007');
    expect(priceCredits(1000, 160000)).toBe(1_600_000);
  });
});

// ---------------------------------------------------------------- harness

type Row = Record<string, unknown> & { id: string };

function harness(opts: { balance?: number; usage?: Array<{ costCode: string; label: string; requests: number; credits: number }> } = {}) {
  const account: Row = {
    id: 'acc1',
    workspaceId: 'w1',
    status: 'ACTIVE',
    currency: 'NGN',
    per100Minor: null,
    minimumMinor: 0,
    creditLimit: 5000,
    netDays: 14,
    graceDays: 7,
    billingEmail: 'ap@acme.example',
    billTo: null,
    notes: null,
    limitWarnedFor: null,
    startedAt: new Date('2026-07-20T00:00:00Z'),
  };
  const wallet: Row = { id: 'wal1', workspaceId: 'w1', overdraftLimit: 5000 };
  const invoices: Row[] = [];
  let balance = opts.balance ?? -1200;
  const usage = opts.usage ?? [{ costCode: 'image.storefront', label: 'Storefront image', requests: 12, credits: 1200 }];
  const mails: string[] = [];
  const notes: string[] = [];
  const ledgerCalls: Array<{ op: string; amount: number; key: string }> = [];

  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'account') return matches(account, v as Record<string, unknown>);
      if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in as unknown[]).includes(row[k]);
      if (v && typeof v === 'object' && 'not' in (v as object)) return row[k] !== (v as { not: unknown }).not;
      if (v && typeof v === 'object' && 'gte' in (v as object))
        return (row[k] as Date) >= (v as { gte: Date }).gte && (row[k] as Date) < (v as { lt: Date }).lt;
      if (v && typeof v === 'object' && 'lt' in (v as object)) return (row[k] as Date) < (v as { lt: Date }).lt;
      if (v && typeof v === 'object' && 'gt' in (v as object)) return (row[k] as number) > (v as { gt: number }).gt;
      return row[k] === v;
    });

  const db = {
    billingAccount: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matches(account, where) ? [{ ...account, workspace: { name: 'Acme', id: 'w1' } }] : [],
      ),
      findUnique: vi.fn(async () => ({ ...account })),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const { OR: _or, ...rest } = where;
        if (!matches(account, rest)) return { count: 0 };
        Object.assign(account, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(account, data)),
    },
    wallet: {
      findUnique: vi.fn(async () => ({ ...wallet })),
      findUniqueOrThrow: vi.fn(async () => ({ ...wallet })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(wallet, data)),
    },
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({ name: 'Acme' })),
      findFirst: vi.fn(async () => ({ id: 'w1', currency: 'NGN', type: 'ORGANIZATION' })),
    },
    workspaceMember: { findMany: vi.fn(async () => [{ role: 'OWNER', user: { email: 'owner@acme.example', name: 'Ada' } }]) },
    usageRate: { findUnique: vi.fn(async () => ({ currency: 'NGN', per100Minor: 160000 })) },
    invoice: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const hits = invoices.filter((i) => matches(i, where)).sort((a, b) => (b.periodEnd as Date).getTime() - (a.periodEnd as Date).getTime());
        return hits[0] ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        invoices.filter((i) => matches(i, where)).map((i) => ({ ...i, account: { ...account }, workspace: { name: 'Acme' } })),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = invoices.find((x) => x.id === where.id);
        return i ? { ...i, account: { ...account }, workspace: { name: 'Acme' } } : null;
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => invoices.filter((i) => matches(i, where)).length),
      aggregate: vi.fn(async () => ({ _count: 0, _sum: { totalMinor: 0 } })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (invoices.some((i) => i.accountId === data.accountId && (i.periodStart as Date).getTime() === (data.periodStart as Date).getTime())) {
          const e = Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['accountId', 'periodStart'] } });
          Object.setPrototypeOf(e, PrismaKnownError.prototype);
          throw e;
        }
        const row = { id: `inv${invoices.length + 1}`, status: 'OPEN', ...data } as Row;
        invoices.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(
          invoices.find((i) => i.id === where.id)!,
          data,
        ),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = invoices.filter((i) => matches(i, where));
        for (const i of hit) Object.assign(i, data);
        return { count: hit.length };
      }),
    },
    $queryRaw: vi.fn(async () => usage.map((u) => ({ ...u, requests: BigInt(u.requests), credits: BigInt(u.credits) }))),
  };
  const ledger = {
    balance: vi.fn(async () => balance),
    purchase: vi.fn(async (m: { amount: number; idempotencyKey: string }) => {
      ledgerCalls.push({ op: 'purchase', amount: m.amount, key: m.idempotencyKey });
      balance += m.amount;
      return { id: `le-${ledgerCalls.length}` };
    }),
    grant: vi.fn(async (m: { amount: number; idempotencyKey: string }) => {
      ledgerCalls.push({ op: 'grant', amount: m.amount, key: m.idempotencyKey });
      balance += m.amount;
      return { id: `le-${ledgerCalls.length}` };
    }),
  };
  const mailer = { send: vi.fn(async (m: { to: string; subject: string }) => void mails.push(`${m.to}: ${m.subject}`)) };
  const notifications = { notifyWorkspace: vi.fn(async (_w: string, _e: null, n: { title: string }) => void notes.push(n.title)), notify: vi.fn() };
  const svc = new UsageBillingService(db as never, ledger as never, mailer as never, notifications as never);
  return {
    svc,
    account,
    wallet,
    invoices,
    mails,
    notes,
    ledgerCalls,
    db,
    get balance() {
      return balance;
    },
  };
}

// Prisma's known-error class is what the service checks with instanceof; stand one in.
import { Prisma } from '@prisma/client';
const PrismaKnownError = Prisma.PrismaClientKnownRequestError;

describe('closeDue', () => {
  beforeEach(() => {
    process.env.APP_ENV = 'dev';
  });

  it('issues one invoice per finished month, from the month the account opened, and none for the open month', async () => {
    const h = harness();
    const n = await h.svc.closeDue(new Date('2026-09-05T10:00:00Z'));
    expect(n).toBe(2); // July (partial) and August
    expect(h.invoices.map((i) => [i.number, (i.periodStart as Date).toISOString().slice(0, 10), (i.periodEnd as Date).toISOString().slice(0, 10)])).toEqual([
      ['INV-202607-0001', '2026-07-01', '2026-08-01'],
      ['INV-202608-0001', '2026-08-01', '2026-09-01'],
    ]);
    const inv = h.invoices[0]!;
    expect(inv.credits).toBe(1200);
    expect(inv.totalMinor).toBe(1_920_000); // 1200 × ₦1,600 / 100
    expect(inv.status).toBe('OPEN');
    expect(inv.dueAt).toBeInstanceOf(Date);
    expect(h.mails).toHaveLength(4); // owner + billing address, per invoice
    expect(h.mails[0]).toContain('owner@acme.example: Invoice INV-202607-0001');
    expect(h.notes[0]).toMatch(/^Invoice INV-202607-0001/);

    // Running again changes nothing.
    expect(await h.svc.closeDue(new Date('2026-09-05T11:00:00Z'))).toBe(0);
  });

  it('closes a quiet month as paid with nothing to bill, and stays silent', async () => {
    const h = harness({ usage: [] });
    await h.svc.closeDue(new Date('2026-09-05T10:00:00Z'));
    expect(h.invoices.every((i) => i.status === 'PAID' && i.paidVia === 'ZERO' && i.totalMinor === 0)).toBe(true);
    expect(h.mails).toHaveLength(0);
  });
});

describe('dun', () => {
  it('marks a past-due invoice overdue once, then pauses the account after grace and closes the line', async () => {
    const h = harness();
    await h.svc.closeDue(new Date('2026-09-05T10:00:00Z'));
    const inv = h.invoices[1]!;
    inv.dueAt = new Date('2026-09-19T00:00:00Z');
    h.invoices[0]!.status = 'PAID';

    const first = await h.svc.dun(new Date('2026-09-20T00:00:00Z'));
    expect(first).toEqual({ overdue: 1, suspended: 0 });
    expect(inv.status).toBe('OVERDUE');
    expect(h.mails.filter((m) => m.includes('overdue'))).toHaveLength(2);
    expect(h.account.status).toBe('ACTIVE');

    // Same day again: no second reminder, still inside grace.
    expect(await h.svc.dun(new Date('2026-09-21T00:00:00Z'))).toEqual({ overdue: 0, suspended: 0 });

    const later = await h.svc.dun(new Date('2026-09-27T00:00:00Z'));
    expect(later).toEqual({ overdue: 0, suspended: 1 });
    expect(h.account.status).toBe('SUSPENDED');
    expect(h.wallet.overdraftLimit).toBe(0);
    expect(h.mails.some((m) => m.includes('is paused'))).toBe(true);
  });

  it('paying the overdue invoice returns the credits and reopens the line', async () => {
    const h = harness();
    await h.svc.closeDue(new Date('2026-09-05T10:00:00Z'));
    h.invoices[0]!.status = 'PAID';
    const inv = h.invoices[1]!;
    inv.dueAt = new Date('2026-09-10T00:00:00Z');
    await h.svc.dun(new Date('2026-09-30T00:00:00Z'));
    expect(h.account.status).toBe('SUSPENDED');

    const before = h.balance;
    const paid = await h.svc.settleInvoice(inv.id, 'MANUAL', 'GTB-4411', null);
    expect(paid.status).toBe('PAID');
    expect(h.ledgerCalls).toEqual([{ op: 'purchase', amount: 1200, key: `invoice:${inv.id}` }]);
    expect(h.balance).toBe(before + 1200);
    expect(h.account.status).toBe('ACTIVE');
    expect(h.wallet.overdraftLimit).toBe(5000);
    expect(h.mails.some((m) => m.includes('Paid: invoice'))).toBe(true);

    // Settling twice is one grant.
    await h.svc.settleInvoice(inv.id, 'FLUTTERWAVE', 'flw-1', 'pay1');
    expect(h.ledgerCalls).toHaveLength(1);
  });
});

describe('warnLimits', () => {
  it('warns once per period at 80% of the line', async () => {
    const h = harness({ balance: -4100 });
    expect(await h.svc.warnLimits(new Date('2026-09-05T10:00:00Z'))).toBe(1);
    expect(h.notes.at(-1)).toMatch(/82% of the credit line used/);
    expect(await h.svc.warnLimits(new Date('2026-09-06T10:00:00Z'))).toBe(0);
  });

  it('stays quiet below the mark', async () => {
    const h = harness({ balance: -1000 });
    expect(await h.svc.warnLimits(new Date('2026-09-05T10:00:00Z'))).toBe(0);
  });
});
