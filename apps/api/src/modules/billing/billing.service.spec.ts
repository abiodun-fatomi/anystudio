/**
 * Payments: the properties that keep money honest.
 *
 * The signature checks are pure and run everywhere. The settlement tests run
 * against Postgres (skipped without DATABASE_URL, always in CI) with the stub
 * gateway, because the properties that matter — one grant per payment however
 * many times we are told, credits withheld on a mismatch, a refund taking
 * them back — are ledger properties.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../notification/notification.service';
import { GenerationHooks } from '../generation/generation.hooks';
import { PrismaClient, type Payment, type Subscription } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { ProviderError } from '@anystudio/shared';
import type { Request } from 'express';
import { PaddleGateway } from './gateways/paddle.gateway';
import { FlutterwaveGateway } from './gateways/flutterwave.gateway';
import { GatewayRegistry } from './gateways/gateway.registry';
import { BillingService, priceIn } from './billing.service';
import { providerForCurrency, toMinor, type Gateway, type RefundVerification, type Verification, type WebhookIntent } from './billing.types';
import { LedgerService } from '../ledger/ledger.service';
import { UsageBillingService } from '../usage-billing/usage-billing.service';
import type { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/policy';

describe('Paddle signature', () => {
  const secret = 'pdl_ntfset_test';
  const body = Buffer.from('{"event_id":"evt_1","event_type":"transaction.completed","data":{"id":"txn_1"}}');
  it('accepts ts:h1 over the raw body and rejects a tampered body or an old timestamp', () => {
    const ts = Math.floor(Date.now() / 1000);
    const h1 = createHmac('sha256', secret).update(`${ts}:`).update(body).digest('hex');
    expect(PaddleGateway.verifySignature(`ts=${ts};h1=${h1}`, body, secret)).toBe(true);
    expect(PaddleGateway.verifySignature(`ts=${ts};h1=${h1}`, Buffer.from(body.toString() + ' '), secret)).toBe(false);
    expect(PaddleGateway.verifySignature(`ts=${ts};h1=${h1}`, body, 'other')).toBe(false);
    expect(
      PaddleGateway.verifySignature(
        `ts=${ts - 3600};h1=${createHmac('sha256', secret)
          .update(`${ts - 3600}:`)
          .update(body)
          .digest('hex')}`,
        body,
        secret,
      ),
    ).toBe(false);
    // Key rotation: two h1 values, either may match.
    expect(PaddleGateway.verifySignature(`ts=${ts};h1=deadbeef;h1=${h1}`, body, secret)).toBe(true);
  });
  it('parses a webhook into a receipt id and an intent', () => {
    const g = new PaddleGateway('key', secret, 'sandbox');
    const ts = Math.floor(Date.now() / 1000);
    const raw = Buffer.from(
      JSON.stringify({
        event_id: 'evt_9',
        event_type: 'transaction.completed',
        data: { id: 'txn_9', customer_id: 'ctm_1', subscription_id: null, custom_data: { reference: 'as_pack_abc' } },
      }),
    );
    const parsed = g.parseWebhook(raw, { 'paddle-signature': `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:`).update(raw).digest('hex')}` });
    expect(parsed.signatureOk).toBe(true);
    expect(parsed.eventId).toBe('evt_9');
    expect(g.interpret(parsed)).toMatchObject({ kind: 'charge', reference: 'as_pack_abc', providerRef: 'txn_9', status: 'succeeded' });
  });
});

describe('Flutterwave signature', () => {
  const g = new FlutterwaveGateway('FLWSECK-x', 'my-dashboard-hash');
  const raw = Buffer.from(
    JSON.stringify({
      event: 'charge.completed',
      data: { id: 123, tx_ref: 'as_pack_x', amount: 5000, currency: 'NGN', status: 'successful', customer: { email: 'A@b.ng' } },
    }),
  );
  it('accepts the dashboard hash in verif-hash and the v4 HMAC, rejects anything else', () => {
    expect(g.parseWebhook(raw, { 'verif-hash': 'my-dashboard-hash' }).signatureOk).toBe(true);
    expect(g.parseWebhook(raw, { 'verif-hash': 'wrong' }).signatureOk).toBe(false);
    expect(g.parseWebhook(raw, {}).signatureOk).toBe(false);
    expect(g.parseWebhook(raw, { 'flutterwave-signature': createHmac('sha256', 'my-dashboard-hash').update(raw).digest('hex') }).signatureOk).toBe(true);
  });
  it('derives a stable event id and a charge intent', () => {
    const p = g.parseWebhook(raw, { 'verif-hash': 'my-dashboard-hash' });
    expect(p.eventId).toBe('charge.completed:123');
    expect(g.interpret(p)).toMatchObject({ kind: 'charge', reference: 'as_pack_x', providerRef: '123', status: 'succeeded', customerRef: 'a@b.ng' });
  });
});

describe('pricing helpers', () => {
  it('routes African currencies to Flutterwave and the rest to Paddle', () => {
    expect(providerForCurrency('NGN')).toBe('FLUTTERWAVE');
    expect(providerForCurrency('kes')).toBe('FLUTTERWAVE');
    expect(providerForCurrency('USD')).toBe('PADDLE');
    expect(providerForCurrency('EUR')).toBe('PADDLE');
  });
  it('never converts: a missing tier is null, not a guess', () => {
    expect(priceIn({ USD: 9, NGN: 12000 }, 'ngn')).toBe(12000);
    expect(priceIn({ USD: 9 }, 'GBP')).toBeNull();
    expect(toMinor(12000, 'NGN')).toBe(1_200_000);
    expect(toMinor(5000, 'UGX')).toBe(5000);
  });
});

describe('legacy invoice payment containment', () => {
  it('queues a system refund when a late checkout reaches an invoice already paid manually', async () => {
    const now = new Date('2026-09-07T00:00:00.000Z');
    const payment = {
      id: '00000000-0000-4000-8000-000000000101',
      workspaceId: '00000000-0000-4000-8000-000000000102',
      userId: '00000000-0000-4000-8000-000000000103',
      provider: 'STUB',
      kind: 'INVOICE',
      status: 'FAILED',
      reference: 'as_inv_late_unit',
      providerRef: null,
      itemCode: 'INV-LEGACY-1',
      interval: null,
      credits: 200,
      amountMinor: 500_000,
      currency: 'NGN',
      checkoutUrl: null,
      providerPayload: null,
      ledgerEntryId: null,
      subscriptionId: null,
      failureReason: null,
      refundedAt: null,
      createdAt: now,
      updatedAt: now,
    } as Payment;
    const verification: Extract<Verification, { ok: true }> = {
      ok: true,
      providerRef: 'stub_late_unit',
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      raw: { status: 'successful' },
    };
    const updated = { ...payment, status: 'NEEDS_REVIEW', providerRef: verification.providerRef } as Payment;
    const paymentUpdate = vi.fn(async () => updated);
    const refundUpsert = vi.fn(async () => ({}));
    const settleInvoice = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: payment.id }]),
      payment: { findUniqueOrThrow: vi.fn(async () => payment), findFirst: vi.fn(async () => null), update: paymentUpdate },
      invoice: {
        findUnique: vi.fn(async () => ({
          id: '00000000-0000-4000-8000-000000000104',
          number: payment.itemCode,
          workspaceId: payment.workspaceId,
          status: 'PAID',
          paymentId: null,
          paidVia: 'MANUAL',
          paidReference: 'BANK-SETTLED',
        })),
      },
      refundRequest: { upsert: refundUpsert },
    };
    const db = { $transaction: vi.fn(async (work: (client: typeof tx) => Promise<Payment>) => work(tx)) };
    const service = new BillingService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      { notify: vi.fn() } as never,
      { settleInvoice, completeInvoiceSettlement: vi.fn() } as never,
      {} as never,
    );
    const settle = (
      service as unknown as {
        settle(row: Payment, result: Extract<Verification, { ok: true }>, via: 'return'): Promise<Payment>;
      }
    ).settle.bind(service);

    await expect(settle(payment, verification, 'return')).resolves.toMatchObject({ status: 'NEEDS_REVIEW' });
    expect(settleInvoice).not.toHaveBeenCalled();
    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_REVIEW', failureReason: expect.stringContaining('already paid via MANUAL') }) }),
    );
    expect(refundUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'PROCESSING', requestedById: null, processingAt: null }),
      }),
    );
  });
});

describe('renewal failure ordering', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  const payment = {
    id: '00000000-0000-4000-8000-000000000201',
    workspaceId: '00000000-0000-4000-8000-000000000202',
    provider: 'STUB',
    kind: 'RENEWAL',
    status: 'PENDING',
    reference: 'as_renew_ordering_unit',
    providerRef: 'stub_renew_ordering_unit',
    itemCode: 'test.plan',
    interval: 'month',
    credits: 600,
    amountMinor: 1_200_000,
    currency: 'NGN',
    subscriptionId: '00000000-0000-4000-8000-000000000203',
    providerPayload: null,
    createdAt: now,
    updatedAt: now,
  } as Payment;
  const subscription = {
    id: payment.subscriptionId,
    workspaceId: payment.workspaceId,
    provider: payment.provider,
    providerRef: 'stub_subscription_ordering_unit',
    planCode: payment.itemCode,
    interval: payment.interval,
    status: 'ACTIVE',
    currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
    providerUpdatedAt: null,
  } as Subscription;

  async function applyFailure(raw: unknown, successfulRenewals: Array<Pick<Payment, 'id' | 'createdAt' | 'updatedAt' | 'providerPayload'>>) {
    const markPastDue = vi.fn(async () => ({ count: 1 }));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: payment.id }]),
      payment: {
        findUniqueOrThrow: vi.fn(async () => payment),
        update: vi.fn(async () => ({ ...payment, status: 'FAILED' }) as Payment),
        findMany: vi.fn(async () => successfulRenewals),
      },
      subscription: {
        findUnique: vi.fn(async () => subscription),
        updateMany: markPastDue,
      },
    };
    const db = { $transaction: vi.fn(async (work: (client: typeof tx) => Promise<Payment>) => work(tx)) };
    const service = new BillingService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const settle = (
      service as unknown as {
        settle(row: Payment, result: Verification, via: 'webhook'): Promise<Payment>;
      }
    ).settle.bind(service);
    await settle(payment, { ok: false, state: 'failed', reason: 'declined', raw }, 'webhook');
    return { markPastDue, queryRaw: tx.$queryRaw };
  }

  it('keeps service active when provider occurrence proves another renewal is newer', async () => {
    const result = await applyFailure({ created_at: '2026-10-01T00:00:00.000Z' }, [
      {
        id: '00000000-0000-4000-8000-000000000204',
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
        updatedAt: new Date('2026-11-01T00:00:01.000Z'),
        providerPayload: { verification: { created_at: '2026-11-01T00:00:00.000Z' } },
      },
    ]);

    expect(result.queryRaw).toHaveBeenCalledTimes(4);
    expect(result.markPastDue).not.toHaveBeenCalled();
  });

  it('marks the subscription past due when the failed provider period follows the paid period', async () => {
    const result = await applyFailure(
      {
        created_at: '2026-12-01T00:00:01.000Z',
        billing_period: { starts_at: '2026-12-01T00:00:00.000Z', ends_at: '2027-01-01T00:00:00.000Z' },
      },
      [
        {
          id: '00000000-0000-4000-8000-000000000205',
          createdAt: new Date('2026-11-01T00:00:00.000Z'),
          updatedAt: new Date('2026-11-01T00:00:01.000Z'),
          providerPayload: { verification: { created_at: '2026-11-01T00:00:00.000Z' } },
        },
      ],
    );

    expect(result.markPastDue).toHaveBeenCalledWith({
      where: { id: subscription.id, status: { in: ['ACTIVE', 'PAUSED'] } },
      data: { status: 'PAST_DUE' },
    });
  });
});

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('BillingService (stub gateway, real ledger)', () => {
  const db = new PrismaClient();
  const ledger = new LedgerService(db);
  const registry = new GatewayRegistry();
  const auth = { publicOrigin: () => 'https://app.test' } as unknown as AuthService;
  const notifications = new NotificationService(db, new GenerationHooks());
  const mailer = { send: vi.fn(async () => ({})) } as never;
  const usageBilling = new UsageBillingService(db, ledger, mailer, notifications);
  const service = new BillingService(db, ledger, registry, auth, notifications, usageBilling, mailer);
  const req = { ip: '127.0.0.1', requestId: 'req_test', get: () => 'test' } as unknown as Request;

  async function waitForOutcome(eventId: string, expected: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const receipt = await db.webhookReceipt.findUnique({ where: { provider_eventId: { provider: 'STUB', eventId } } });
      if (receipt?.outcome === expected) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const receipt = await db.webhookReceipt.findUnique({ where: { provider_eventId: { provider: 'STUB', eventId } } });
    throw new Error(`Webhook ${eventId} did not reach ${expected}; current outcome ${receipt?.outcome ?? 'missing'}`);
  }

  const fromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

  let workspaceId: string;
  let walletId: string;
  let userId: string;
  const actor = (role = 'OWNER'): Actor => ({
    userId,
    surface: 'APP',
    staffRole: null,
    workspaceRoles: new Map([[workspaceId, role as 'OWNER']]),
    mfaLevel: 0,
    lastStepUpAt: null,
    impersonating: false,
  });
  const staffActor = (): Actor => ({
    userId,
    surface: 'ADMIN',
    staffRole: 'ADMIN',
    workspaceRoles: new Map(),
    mfaLevel: 1,
    lastStepUpAt: new Date(),
    impersonating: false,
  });

  async function invoiceFixture() {
    const account = await db.billingAccount.create({
      data: { workspaceId, currency: 'NGN', creditLimit: 1_000, netDays: 14, graceDays: 7 },
    });
    return db.invoice.create({
      data: {
        number: `INV-TEST-${crypto.randomUUID()}`,
        workspaceId,
        accountId: account.id,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
        currency: 'NGN',
        credits: 200,
        per100Minor: 250_000,
        usageMinor: 500_000,
        totalMinor: 500_000,
        lines: [],
        dueAt: new Date('2026-09-15T00:00:00Z'),
      },
    });
  }

  beforeAll(async () => {
    await db.$connect();
    await db.creditPack.upsert({
      where: { code: 'test.pack' },
      create: { code: 'test.pack', credits: 200, priceByMarket: { NGN: 5000, USD: 4 }, providerRefs: {} },
      update: { credits: 200, priceByMarket: { NGN: 5000, USD: 4 }, providerRefs: {}, active: true },
    });
    await db.plan.upsert({
      where: { code: 'test.plan' },
      create: {
        code: 'test.plan',
        credits: 600,
        priceByMarket: { NGN: 12000, USD: 9 },
        yearlyPriceByMarket: { NGN: 120000, USD: 90 },
        providerRefs: {},
      },
      update: {
        credits: 600,
        priceByMarket: { NGN: 12000, USD: 9 },
        yearlyPriceByMarket: { NGN: 120000, USD: 90 },
        providerRefs: {},
        active: true,
      },
    });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    const user = await db.user.create({ data: { email: `bill-${crypto.randomUUID()}@test.local`, name: 'Buyer' } });
    userId = user.id;
    const ws = await db.workspace.create({
      data: { type: 'BUSINESS', name: 'Shop', currency: 'NGN', members: { create: { userId, role: 'OWNER' } }, wallet: { create: {} } },
      include: { wallet: true },
    });
    workspaceId = ws.id;
    walletId = ws.wallet!.id;
    // Maintenance is fleet-wide in production. Restrict its scans to this
    // fixture so a gateway stub in one test cannot settle another test's rows.
    // The original SQL predicates, transactions and locks still run in Postgres.
    const payments = db.payment.findMany.bind(db.payment);
    vi.spyOn(db.payment, 'findMany').mockImplementation((args) => payments({ ...args, where: { AND: [args?.where ?? {}, { workspaceId }] } }) as never);
    const refunds = db.refundRequest.findMany.bind(db.refundRequest);
    vi.spyOn(db.refundRequest, 'findMany').mockImplementation((args) => refunds({ ...args, where: { AND: [args?.where ?? {}, { workspaceId }] } }) as never);
    const subscriptions = db.subscription.findMany.bind(db.subscription);
    vi.spyOn(db.subscription, 'findMany').mockImplementation(
      (args) => subscriptions({ ...args, where: { AND: [args?.where ?? {}, { workspaceId }] } }) as never,
    );
    const receipts = db.webhookReceipt.findMany.bind(db.webhookReceipt);
    const previous = await receipts({ select: { id: true } });
    vi.spyOn(db.webhookReceipt, 'findMany').mockImplementation(
      (args) => receipts({ ...args, where: { AND: [args?.where ?? {}, { id: { notIn: previous.map((row) => row.id) } }] } }) as never,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('prices on the server, and the catalogue speaks the workspace currency', async () => {
    const c = await service.catalogue(workspaceId);
    expect(c.currency).toBe('NGN');
    expect(c.provider).toBe('STUB');
    expect(c.packs.find((p) => p.code === 'test.pack')?.price).toBe(5000);
    expect(c.plans.find((p) => p.code === 'test.plan')?.year?.price).toBe(120000);
  });

  it('derives apply, forced clawback and reads from signed deltas when timestamps tie', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const highId = `ffffffff-ffff-4fff-8fff-${suffix}`;
    const lowId = `00000000-0000-4000-8000-${suffix}`;
    const seedKey = crypto.randomUUID();

    await db.$transaction(async (tx) => {
      // Deliberately model two historical rows written in one transaction.
      // UUID order says the +100 row is "newer", although the -30 row is the
      // actual second row. The aggregate remains unambiguous: 70.
      await tx.$executeRaw`
        INSERT INTO "ledger_entries"
          ("id", "walletId", "kind", "delta", "balanceAfter", "referenceId", "idempotencyKey", "reason", "actorId", "createdAt")
        VALUES
          (CAST(${highId} AS uuid), CAST(${walletId} AS uuid), 'PROMO', 100, 100, NULL, ${`tied:${seedKey}:one`}, 'same timestamp regression', NULL, now()),
          (CAST(${lowId} AS uuid), CAST(${walletId} AS uuid), 'DEBIT', -30, 70, NULL, ${`tied:${seedKey}:two`}, 'same timestamp regression', NULL, now())
      `;

      const purchase = await ledger.purchase({ walletId, amount: 10, idempotencyKey: `tied:${seedKey}:purchase` }, tx);
      expect(purchase.balanceAfter).toBe(80);
      const clawback = await ledger.forceClawback({ walletId, amount: 20, idempotencyKey: `tied:${seedKey}:forced` }, tx);
      expect(clawback.balanceAfter).toBe(60);

      const [facts] = await tx.$queryRaw<Array<{ balance: number; drift: number; timestamps: number }>>`
        SELECT ledger_balance(CAST(${walletId} AS uuid)) AS balance,
               ledger_drift(CAST(${walletId} AS uuid)) AS drift,
               COUNT(DISTINCT "createdAt") FILTER (WHERE "idempotencyKey" IN (${`tied:${seedKey}:one`}, ${`tied:${seedKey}:two`}))::integer AS timestamps
          FROM "ledger_entries"
         WHERE "walletId" = CAST(${walletId} AS uuid)
      `;
      expect(facts).toEqual({ balance: 60, drift: 0, timestamps: 1 });
    });
  });

  it('lets an online settlement win once and rejects a conflicting manual identity after the lock', async () => {
    const invoice = await invoiceFixture();
    const payment = await db.payment.create({
      data: {
        workspaceId,
        userId,
        provider: 'STUB',
        kind: 'INVOICE',
        reference: `as_inv_identity_${crypto.randomUUID()}`,
        itemCode: invoice.number,
        credits: invoice.credits,
        amountMinor: invoice.totalMinor,
        currency: invoice.currency,
      },
    });
    const providerRef = `stub_identity_${payment.id}`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled!: () => void;
    const settledInsideTransaction = new Promise<void>((resolve) => {
      settled = resolve;
    });

    const online = db.$transaction(async (tx) => {
      const paid = await usageBilling.settleInvoice(invoice.id, 'STUB', providerRef, payment.id, tx);
      settled();
      await held;
      return paid;
    });
    await settledInsideTransaction;
    const manual = usageBilling.settleInvoice(invoice.id, 'MANUAL', 'BANK-RACE-1', null);
    release();

    const [onlineResult, manualResult] = await Promise.allSettled([online, manual]);
    expect(onlineResult.status).toBe('fulfilled');
    expect(manualResult).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({
      status: 'PAID',
      paidVia: 'STUB',
      paidReference: providerRef,
      paymentId: payment.id,
    });
    expect(await db.ledgerEntry.count({ where: { walletId, idempotencyKey: `invoice:${invoice.id}` } })).toBe(1);
  });

  it('contains a charge with a different provider reference even when the paid invoice links its payment id', async () => {
    const invoice = await invoiceFixture();
    const payment = await db.payment.create({
      data: {
        workspaceId,
        userId,
        provider: 'STUB',
        kind: 'INVOICE',
        reference: `as_inv_linked_conflict_${crypto.randomUUID()}`,
        itemCode: invoice.number,
        credits: invoice.credits,
        amountMinor: invoice.totalMinor,
        currency: invoice.currency,
      },
    });
    const originalRef = `stub_original_${payment.id}`;
    await usageBilling.settleInvoice(invoice.id, 'STUB', originalRef, payment.id);
    const before = await ledger.balance(walletId);
    expect((await service.verifyPayment(workspaceId, payment.id, { providerRef: `stub_conflict_${payment.id}` }, req)).status).toBe('NEEDS_REVIEW');
    expect(await db.refundRequest.findUniqueOrThrow({ where: { paymentId: payment.id } })).toMatchObject({ status: 'PROCESSING', requestedById: null });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: 'PAID', paidReference: originalRef });
    expect(await ledger.balance(walletId)).toBe(before);
    expect(await db.ledgerEntry.count({ where: { walletId, idempotencyKey: `invoice:${invoice.id}` } })).toBe(1);
    expect((await service.maintenanceTick()).refundsCompleted).toBe(1);
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: 'REFUNDED' });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: 'PAID', paidReference: originalRef });
    expect(await ledger.balance(walletId)).toBe(before);
  });

  it('cannot void an invoice after an in-flight settlement has acquired its lock', async () => {
    const invoice = await invoiceFixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled!: () => void;
    const settledInsideTransaction = new Promise<void>((resolve) => {
      settled = resolve;
    });

    const settlement = db.$transaction(async (tx) => {
      const paid = await usageBilling.settleInvoice(invoice.id, 'MANUAL', 'BANK-WINNER', null, tx);
      settled();
      await held;
      return paid;
    });
    await settledInsideTransaction;
    const voiding = usageBilling.voidInvoice(staffActor(), invoice.id, 'race regression', req);
    // Let the competing request read the pre-commit OPEN snapshot and reach
    // the invoice lock before allowing the winner to commit.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();

    const [settlementResult, voidResult] = await Promise.allSettled([settlement, voiding]);
    expect(settlementResult.status).toBe('fulfilled');
    expect(voidResult).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true, paidReference: true } })).toEqual({
      status: 'PAID',
      paidReference: 'BANK-WINNER',
    });
    expect(await db.ledgerEntry.count({ where: { walletId, idempotencyKey: { in: [`invoice:${invoice.id}`, `invoice:${invoice.id}:void`] } } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { walletId, idempotencyKey: `invoice:${invoice.id}:void` } })).toBe(0);
  });

  it('offers Flutterwave one-off packs without requiring a gateway product id', async () => {
    const route = vi.spyOn(registry, 'forCurrency').mockReturnValue(new FlutterwaveGateway('test-key', 'test-secret'));
    try {
      const c = await service.catalogue(workspaceId);
      expect(c.provider).toBe('FLUTTERWAVE');
      expect(c.packs.find((p) => p.code === 'test.pack')?.canBuy).toBe(true);
      expect(c.plans.find((p) => p.code === 'test.plan')?.month.canBuy).toBe(false);
    } finally {
      route.mockRestore();
    }
  });

  it('retries the local write after a provider checkout succeeds so a transient DB failure cannot strand the plan', async () => {
    const persist = vi.spyOn(db.payment, 'updateMany').mockRejectedValueOnce(new Error('database failover'));
    try {
      const opened = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
      const reused = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
      expect(reused).toMatchObject({ paymentId: opened.paymentId, url: opened.url });
      expect(persist).toHaveBeenCalledTimes(2);
    } finally {
      persist.mockRestore();
    }
  });

  it('releases an invoice reservation after an unreturned checkout exhausts reconciliation', async () => {
    const invoice = await invoiceFixture();
    const payment = await db.payment.create({
      data: {
        workspaceId,
        userId,
        provider: 'STUB',
        kind: 'INVOICE',
        reference: `as_inv_orphan_${crypto.randomUUID()}`,
        itemCode: invoice.number,
        credits: invoice.credits,
        amountMinor: invoice.totalMinor,
        currency: invoice.currency,
        providerPayload: { stub: 'pending', checkoutRecovery: { attempts: 19 } },
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    await db.invoice.update({ where: { id: invoice.id }, data: { paymentId: payment.id } });

    const tick = await service.maintenanceTick();

    expect(tick.checkoutsResolved).toBeGreaterThanOrEqual(1);
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true, failureReason: true } })).toMatchObject({
      status: 'FAILED',
      failureReason: expect.stringContaining('checkout abandoned:'),
    });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { paymentId: true } })).toEqual({ paymentId: null });
    await expect(service.payInvoice(actor(), workspaceId, invoice.id, req)).resolves.toMatchObject({ provider: 'STUB' });
  });

  it('settles an invoice charge and applies its early chargeback atomically, then reverses both exactly once', async () => {
    const invoice = await invoiceFixture();
    const opened = await service.payInvoice(actor(), workspaceId, invoice.id, req);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: opened.paymentId } });
    const adjustmentRef = `stub_invoice_chargeback_early_${payment.id}`;
    const adjustment = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded' | 'reversed'; providerRef: string; amountMinor: number; currency: string },
          reason: 'chargeback',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);

    expect(
      await adjustment(payment, { state: 'succeeded', providerRef: adjustmentRef, amountMinor: payment.amountMinor, currency: payment.currency }, 'chargeback'),
    ).toBe('chargeback_confirmed');
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true, ledgerEntryId: true } })).toMatchObject({
      status: 'REFUNDED',
      ledgerEntryId: expect.any(String),
    });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true, paymentId: true } })).toEqual({
      status: 'DISPUTED',
      paymentId: payment.id,
    });
    expect(await ledger.balance(walletId)).toBe(0);
    expect(await db.ledgerEntry.count({ where: { walletId, idempotencyKey: `invoice:${invoice.id}` } })).toBe(1);

    expect(
      await adjustment(
        await db.payment.findUniqueOrThrow({ where: { id: payment.id } }),
        { state: 'reversed', providerRef: adjustmentRef, amountMinor: payment.amountMinor, currency: payment.currency },
        'chargeback',
      ),
    ).toBe('refund_reversed');

    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true } })).toEqual({ status: 'SUCCEEDED' });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true } })).toEqual({ status: 'PAID' });
    expect(await ledger.balance(walletId)).toBe(invoice.credits);
    expect(await db.ledgerEntry.count({ where: { walletId, idempotencyKey: `invoice:${invoice.id}` } })).toBe(1);
  });

  it('suspends an invoice credit line on a fulfilled refund and reactivates it only after a clear reversal', async () => {
    const invoice = await invoiceFixture();
    await db.wallet.update({ where: { id: walletId }, data: { overdraftLimit: 1_000 } });
    const opened = await service.payInvoice(actor(), workspaceId, invoice.id, req);
    await service.verifyPayment(workspaceId, opened.paymentId, {}, req);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: opened.paymentId } });
    const adjustmentRef = `stub_invoice_refund_${payment.id}`;
    const apply = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded' | 'reversed'; providerRef: string; amountMinor: number; currency: string },
          reason: 'refund',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);

    expect(
      await apply(payment, { state: 'succeeded', providerRef: adjustmentRef, amountMinor: payment.amountMinor, currency: payment.currency }, 'refund'),
    ).toBe('refunded');
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true } })).toEqual({ status: 'REFUNDED' });
    expect(await db.billingAccount.findUniqueOrThrow({ where: { id: invoice.accountId }, select: { status: true, suspendedReason: true } })).toMatchObject({
      status: 'SUSPENDED',
      suspendedReason: expect.stringContaining(invoice.number),
    });
    expect(await db.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { overdraftLimit: true } })).toEqual({ overdraftLimit: 0 });

    expect(
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: payment.id } }),
        { state: 'reversed', providerRef: adjustmentRef, amountMinor: payment.amountMinor, currency: payment.currency },
        'refund',
      ),
    ).toBe('refund_reversed');
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true } })).toEqual({ status: 'PAID' });
    expect(await db.billingAccount.findUniqueOrThrow({ where: { id: invoice.accountId }, select: { status: true, suspendedReason: true } })).toEqual({
      status: 'ACTIVE',
      suspendedReason: null,
    });
    expect(await db.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { overdraftLimit: true } })).toEqual({ overdraftLimit: 1_000 });
  });

  it('keeps an invoice credit line suspended when a reversal leaves another blocker', async () => {
    const invoice = await invoiceFixture();
    await db.wallet.update({ where: { id: walletId }, data: { overdraftLimit: 1_000 } });
    const opened = await service.payInvoice(actor(), workspaceId, invoice.id, req);
    await service.verifyPayment(workspaceId, opened.paymentId, {}, req);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: opened.paymentId } });
    const adjustmentRef = `stub_invoice_blocked_reversal_${payment.id}`;
    const apply = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded' | 'reversed'; providerRef: string; amountMinor: number; currency: string },
          reason: 'refund',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);
    await apply(payment, { state: 'succeeded', providerRef: adjustmentRef, amountMinor: payment.amountMinor, currency: payment.currency }, 'refund');
    await db.invoice.create({
      data: {
        number: `INV-BLOCKER-${crypto.randomUUID()}`,
        workspaceId,
        accountId: invoice.accountId,
        status: 'OVERDUE',
        periodStart: new Date('2026-09-01T00:00:00Z'),
        periodEnd: new Date('2026-10-01T00:00:00Z'),
        currency: invoice.currency,
        credits: 100,
        per100Minor: invoice.per100Minor,
        usageMinor: 250_000,
        totalMinor: 250_000,
        lines: [],
        dueAt: new Date('2026-10-15T00:00:00Z'),
      },
    });

    await apply(
      await db.payment.findUniqueOrThrow({ where: { id: payment.id } }),
      { state: 'reversed', providerRef: adjustmentRef, amountMinor: payment.amountMinor, currency: payment.currency },
      'refund',
    );
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true } })).toEqual({ status: 'PAID' });
    expect(await db.billingAccount.findUniqueOrThrow({ where: { id: invoice.accountId }, select: { status: true } })).toEqual({ status: 'SUSPENDED' });
    expect(await db.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { overdraftLimit: true } })).toEqual({ overdraftLimit: 0 });
  });

  it('queues a refund instead of granting a contradictory late charge for an abandoned checkout', async () => {
    const payment = await db.payment.create({
      data: {
        workspaceId,
        userId,
        provider: 'STUB',
        kind: 'PACK',
        status: 'FAILED',
        reference: `as_pack_abandoned_${crypto.randomUUID()}`,
        itemCode: 'test.pack',
        credits: 200,
        amountMinor: 500_000,
        currency: 'NGN',
        failureReason: 'checkout abandoned: payment page was never delivered',
      },
    });

    const verified = await service.verifyPayment(workspaceId, payment.id, { providerRef: `stub_late_${payment.id}` }, req);

    expect(verified.status).toBe('NEEDS_REVIEW');
    expect(await ledger.balance(walletId)).toBe(0);
    expect(await db.refundRequest.findUniqueOrThrow({ where: { paymentId: payment.id } })).toMatchObject({
      status: 'PROCESSING',
      requestedById: null,
    });
  });

  it('discovers a response-lost automatic refund before submitting the durable command again', async () => {
    const payment = await db.payment.create({
      data: {
        workspaceId,
        userId,
        provider: 'STUB',
        kind: 'PACK',
        status: 'FAILED',
        reference: `as_pack_response_lost_${crypto.randomUUID()}`,
        itemCode: 'test.pack',
        credits: 200,
        amountMinor: 500_000,
        currency: 'NGN',
        failureReason: 'checkout abandoned: hosted page was never returned',
      },
    });
    await service.verifyPayment(workspaceId, payment.id, { providerRef: `stub_late_${payment.id}` }, req);
    const gateway = registry.get('STUB')!;
    const discover = vi.spyOn(gateway, 'discoverRefund').mockResolvedValueOnce({
      state: 'succeeded',
      providerRef: `stubrefund_discovered_${payment.id}`,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    });
    const refund = vi.spyOn(gateway, 'refund');
    try {
      const tick = await service.maintenanceTick(new Date(Date.now() + 1_000));
      expect(tick.refundsCompleted).toBeGreaterThanOrEqual(1);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(refund).not.toHaveBeenCalled();
    } finally {
      discover.mockRestore();
      refund.mockRestore();
    }
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('REFUNDED');
    expect(await ledger.balance(walletId)).toBe(0);
  });

  it('keeps a pending refund without a stable provider id in discovery mode', async () => {
    const payment = await db.payment.create({
      data: {
        workspaceId,
        userId,
        provider: 'STUB',
        kind: 'PACK',
        status: 'NEEDS_REVIEW',
        reference: `as_pack_unacked_refund_${crypto.randomUUID()}`,
        providerRef: `stub_charge_${crypto.randomUUID()}`,
        itemCode: 'test.pack',
        credits: 200,
        amountMinor: 500_000,
        currency: 'NGN',
      },
    });
    await db.refundRequest.create({
      data: {
        paymentId: payment.id,
        workspaceId,
        requestedById: null,
        reason: 'Automatic recovery: response unknown',
        status: 'PROCESSING',
        balanceAtRequest: 0,
        decidedAt: new Date(Date.now() - 60_000),
        processingAt: null,
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
    });
    const gateway = registry.get('STUB')!;
    const discover = vi.spyOn(gateway, 'discoverRefund').mockResolvedValue({ state: 'pending', reason: 'new refund not found yet' });
    const refund = vi.spyOn(gateway, 'refund').mockResolvedValue({ state: 'pending', reason: 'conflict but no unseen adjustment yet' });
    const verify = vi.spyOn(gateway, 'verifyRefund');
    try {
      await service.maintenanceTick();
      await service.maintenanceTick(new Date(Date.now() + 16 * 60_000));
      expect(discover).toHaveBeenCalledTimes(2);
      expect(refund).toHaveBeenCalledTimes(2);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      discover.mockRestore();
      refund.mockRestore();
      verify.mockRestore();
    }
    expect(await db.refundRequest.findUniqueOrThrow({ where: { paymentId: payment.id } })).toMatchObject({
      status: 'PROCESSING',
      processingAt: expect.any(Date),
      gatewayRef: null,
    });
  });

  it('a pack: checkout writes a PENDING row at the server price; verifying grants once however often it is asked', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    expect(out.amountMinor).toBe(500_000);
    expect(out.url).toContain('/billing/return?ref=');
    expect(new URL(out.url).searchParams.get('paymentId')).toBe(out.paymentId);
    const row = await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } });
    expect(row.status).toBe('PENDING');
    expect(await ledger.balance(walletId)).toBe(0);

    const first = await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_x_${out.paymentId}` }, req);
    expect(first.status).toBe('SUCCEEDED');
    expect(await ledger.balance(walletId)).toBe(200);
    // The return page checks again, and the webhook arrives twice.
    await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    const eventId = 'evt_a_' + out.reference;
    const hook = JSON.stringify({ id: eventId, type: 'charge', reference: out.reference, providerRef: `stub_x_${out.paymentId}`, status: 'succeeded' });
    expect((await service.handleWebhook('STUB', Buffer.from(hook), { 'x-stub-signature': 'stub' })).status).toBe('accepted');
    await waitForOutcome(eventId, 'already_settled');
    expect((await service.handleWebhook('STUB', Buffer.from(hook), { 'x-stub-signature': 'stub' })).status).toBe('duplicate');
    expect(await ledger.balance(walletId)).toBe(200);
    expect(await db.ledgerEntry.count({ where: { walletId } })).toBe(1);
  });

  it('defers an adjustment until the pack charge is paid and rolls settlement back if the adjustment cannot commit', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await db.payment.update({ where: { id: out.paymentId }, data: { providerPayload: { stub: 'pending' } } });
    const adjustmentRef = `stub_pack_adjustment_early_${out.paymentId}`;
    const apply = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
          reason: 'refund',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);

    expect(
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        { state: 'succeeded', providerRef: adjustmentRef, amountMinor: out.amountMinor, currency: out.currency },
        'refund',
      ),
    ).toBe('refund_pending');
    expect(await db.payment.findUniqueOrThrow({ where: { id: out.paymentId }, select: { status: true, ledgerEntryId: true } })).toEqual({
      status: 'PENDING',
      ledgerEntryId: null,
    });
    expect(await db.paymentAdjustment.count({ where: { paymentId: out.paymentId } })).toBe(0);
    expect(await ledger.balance(walletId)).toBe(0);

    await db.payment.update({ where: { id: out.paymentId }, data: { providerPayload: {} } });
    const failAdjustment = vi.spyOn(ledger, 'forceClawback').mockRejectedValueOnce(new Error('simulated adjustment write failure'));
    try {
      await expect(
        apply(
          await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
          { state: 'succeeded', providerRef: adjustmentRef, amountMinor: out.amountMinor, currency: out.currency },
          'refund',
        ),
      ).rejects.toThrow('simulated adjustment write failure');
    } finally {
      failAdjustment.mockRestore();
    }
    // The credit grant ran inside the failed transaction, so none of its
    // state is observable after rollback.
    expect(await db.payment.findUniqueOrThrow({ where: { id: out.paymentId }, select: { status: true, ledgerEntryId: true } })).toEqual({
      status: 'PENDING',
      ledgerEntryId: null,
    });
    expect(await db.ledgerEntry.count({ where: { walletId } })).toBe(0);
    expect(await db.paymentAdjustment.count({ where: { paymentId: out.paymentId } })).toBe(0);

    expect(
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        { state: 'succeeded', providerRef: adjustmentRef, amountMinor: out.amountMinor, currency: out.currency },
        'refund',
      ),
    ).toBe('refunded');
    expect(await db.payment.findUniqueOrThrow({ where: { id: out.paymentId }, select: { status: true, ledgerEntryId: true } })).toMatchObject({
      status: 'REFUNDED',
      ledgerEntryId: expect.any(String),
    });
    expect(await db.ledgerEntry.count({ where: { walletId, idempotencyKey: `payment:${out.paymentId}` } })).toBe(1);
    expect(await db.paymentAdjustment.count({ where: { paymentId: out.paymentId, status: 'SUCCEEDED' } })).toBe(1);
    expect(await ledger.balance(walletId)).toBe(0);
  });

  it('recovers a legacy pre-charge partial adjustment when the charge webhook proves payment', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    const payment = await db.payment.update({
      where: { id: out.paymentId },
      data: { status: 'NEEDS_REVIEW', failureReason: `Partial provider adjustment: 250000 of ${out.amountMinor} ${out.currency}` },
    });
    const adjustmentRef = `stub_legacy_partial_${payment.id}`;
    await db.paymentAdjustment.create({
      data: {
        paymentId: payment.id,
        provider: payment.provider,
        providerRef: adjustmentRef,
        reason: 'REFUND',
        status: 'SUCCEEDED',
        amountMinor: 250_000,
        amountDeltaMinor: -250_000,
        currency: payment.currency,
        creditDelta: 0,
        appliedAt: new Date(),
      },
    });

    const eventId = `evt_legacy_adjustment_recovery_${payment.reference}`;
    const hook = JSON.stringify({ id: eventId, type: 'charge', reference: payment.reference, providerRef: payment.providerRef, status: 'succeeded' });
    expect((await service.handleWebhook('STUB', Buffer.from(hook), { 'x-stub-signature': 'stub' })).status).toBe('accepted');
    await waitForOutcome(eventId, 'partial_adjustment_recorded');

    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true, ledgerEntryId: true } })).toMatchObject({
      status: 'NEEDS_REVIEW',
      ledgerEntryId: expect.any(String),
    });
    expect(
      await db.paymentAdjustment.findUniqueOrThrow({ where: { provider_providerRef: { provider: payment.provider, providerRef: adjustmentRef } } }),
    ).toMatchObject({
      amountDeltaMinor: -250_000,
      creditDelta: -100,
    });
    expect(await ledger.balance(walletId)).toBe(100);
  });

  it('uses Paddle gross as the refund denominator when an adjustment arrives before the taxed charge', async () => {
    const payment = await db.payment.create({
      data: {
        workspaceId,
        userId,
        provider: 'PADDLE',
        kind: 'PACK',
        reference: `as_paddle_tax_order_${crypto.randomUUID()}`,
        providerRef: `txn_tax_order_${crypto.randomUUID()}`,
        itemCode: 'taxed.pack',
        credits: 120,
        amountMinor: 1_000,
        currency: 'USD',
      },
    });
    const paddle = {
      provider: 'PADDLE',
      verify: vi.fn(async () => ({
        ok: true as const,
        providerRef: payment.providerRef!,
        amountMinor: 1_200,
        currency: 'USD',
        raw: { id: payment.providerRef, details: { totals: { grand_total: '1200' } } },
      })),
    } as unknown as Gateway;
    const originalGet = registry.get.bind(registry);
    const get = vi.spyOn(registry, 'get').mockImplementation((provider) => (provider === 'PADDLE' ? paddle : originalGet(provider)));
    try {
      const outcome = await (
        service as unknown as {
          applyConfirmedAdjustment(
            payment: Payment,
            verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
            reason: 'refund',
          ): Promise<string>;
        }
      ).applyConfirmedAdjustment(
        payment,
        { state: 'succeeded', providerRef: `adj_tax_order_${crypto.randomUUID()}`, amountMinor: 1_000, currency: 'USD' },
        'refund',
      );
      expect(outcome).toBe('partial_adjustment_recorded');
    } finally {
      get.mockRestore();
    }

    expect(paddle.verify).toHaveBeenCalledTimes(1);
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true, amountMinor: true, failureReason: true } })).toEqual({
      status: 'NEEDS_REVIEW',
      amountMinor: 1_200,
      failureReason: 'Partial provider adjustment: 1000 of 1200 USD',
    });
    expect(await db.paymentAdjustment.findFirstOrThrow({ where: { paymentId: payment.id }, select: { amountDeltaMinor: true, creditDelta: true } })).toEqual({
      amountDeltaMinor: -1_000,
      creditDelta: -100,
    });
    expect(await ledger.balance(walletId)).toBe(20);
  });

  it('a webhook with a bad signature cannot write attacker-controlled data', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    const hook = JSON.stringify({ id: 'evt_b_' + out.reference, type: 'charge', reference: out.reference, status: 'succeeded' });
    await expect(service.handleWebhook('STUB', Buffer.from(hook), { 'x-stub-signature': 'nope' })).rejects.toMatchObject({ status: 403 });
    expect(await ledger.balance(walletId)).toBe(0);
    const receipt = await db.webhookReceipt.findUnique({ where: { provider_eventId: { provider: 'STUB', eventId: 'evt_b_' + out.reference } } });
    expect(receipt).toBeNull();
  });

  it('records processing errors, asks for redelivery, and reclaims the same receipt on retry', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    const hook = JSON.stringify({
      id: 'evt_retry_' + out.reference,
      type: 'charge',
      reference: out.reference,
      providerRef: `stub_retry_${out.paymentId}`,
      status: 'succeeded',
    });
    const gateway = registry.get('STUB')!;
    const verify = vi.spyOn(gateway, 'verify').mockRejectedValueOnce(new Error('temporary gateway read failure'));
    try {
      expect((await service.handleWebhook('STUB', Buffer.from(hook), { 'x-stub-signature': 'stub' })).status).toBe('accepted');
      const failed = await waitForOutcome('evt_retry_' + out.reference, 'error');
      expect(failed.outcome).toBe('error');
      expect(failed.error).toContain('temporary gateway read failure');

      expect((await service.handleWebhook('STUB', Buffer.from(hook), { 'x-stub-signature': 'stub' })).status).toBe('accepted');
      const recovered = await waitForOutcome('evt_retry_' + out.reference, 'granted');
      expect(recovered.outcome).toBe('granted');
      expect(recovered.error).toBeNull();
      expect(await ledger.balance(walletId)).toBe(200);
      expect(await db.webhookReceipt.count({ where: { provider: 'STUB', eventId: 'evt_retry_' + out.reference } })).toBe(1);
    } finally {
      verify.mockRestore();
    }
  });

  it('a charge that does not match the priced row withholds credits and marks the row', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await db.payment.update({ where: { id: out.paymentId }, data: { providerPayload: { stub: 'short' } } });
    const r = await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.failureReason).toMatch(/mismatch/);
    expect(await ledger.balance(walletId)).toBe(0);
  });

  it('a pending charge stays pending; a declined one fails without a grant', async () => {
    const a = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await db.payment.update({ where: { id: a.paymentId }, data: { providerPayload: { stub: 'pending' } } });
    expect((await service.verifyPayment(workspaceId, a.paymentId, {}, req)).status).toBe('PENDING');
    const b = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await db.payment.update({ where: { id: b.paymentId }, data: { providerPayload: { stub: 'failed' } } });
    expect((await service.verifyPayment(workspaceId, b.paymentId, {}, req)).status).toBe('FAILED');
    expect(await ledger.balance(walletId)).toBe(0);
  });

  it('binds an invoice to one checkout and reuses it regardless of local age', async () => {
    const invoice = await invoiceFixture();
    const first = await service.payInvoice(actor(), workspaceId, invoice.id, req);
    expect(new URL(first.url).searchParams.get('paymentId')).toBe(first.paymentId);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).paymentId).toBe(first.paymentId);
    await db.payment.update({ where: { id: first.paymentId }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });

    const again = await service.payInvoice(actor(), workspaceId, invoice.id, req);
    expect(again.paymentId).toBe(first.paymentId);
    expect(await db.payment.count({ where: { workspaceId, kind: 'INVOICE', itemCode: invoice.number } })).toBe(1);
  });

  it('reconciles response-lost plan and invoice checkouts without submitting a second create', async () => {
    const gateway = registry.get('STUB')!;
    const create = vi.spyOn(gateway, 'createCheckout').mockRejectedValue(new Error('socket closed after request write'));
    const invoice = await invoiceFixture();
    try {
      await expect(service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req)).rejects.toMatchObject({ status: 409 });
      await expect(service.payInvoice(actor(), workspaceId, invoice.id, req)).rejects.toMatchObject({ status: 409 });
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      create.mockRestore();
    }

    const uncertain = await db.payment.findMany({ where: { workspaceId, checkoutUrl: null, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
    expect(uncertain).toHaveLength(2);
    const verify = vi.spyOn(gateway, 'verify').mockResolvedValue({ ok: false, state: 'failed', reason: 'merchant reference was rejected' });
    try {
      const tick = await service.maintenanceTick();
      expect(tick).toMatchObject({ checkoutsChecked: 2, checkoutsResolved: 2 });
    } finally {
      verify.mockRestore();
    }
    expect(await db.payment.count({ where: { id: { in: uncertain.map((p) => p.id) }, status: 'FAILED' } })).toBe(2);

    // Definitive provider failure releases both business reservations. No
    // second create happened during recovery; only these explicit retries do.
    await expect(service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req)).resolves.toHaveProperty('url');
    await expect(service.payInvoice(actor(), workspaceId, invoice.id, req)).resolves.toHaveProperty('url');
  });

  it('immediately releases a checkout rejected by the gateway before creation', async () => {
    const gateway = registry.get('STUB')!;
    const create = vi
      .spyOn(gateway, 'createCheckout')
      .mockRejectedValueOnce(new ProviderError('REQUEST_REJECTED', 'invalid payment request', 'stub', { status: 422 }));
    try {
      await expect(service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req)).rejects.toMatchObject({ status: 409 });
    } finally {
      create.mockRestore();
    }
    expect(await db.payment.findFirst({ where: { workspaceId, kind: 'SUBSCRIPTION' }, orderBy: { createdAt: 'desc' }, select: { status: true } })).toEqual({
      status: 'FAILED',
    });
    await expect(service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req)).resolves.toHaveProperty('url');
  });

  it('contains a late old-plan charge instead of replacing the newer active subscription', async () => {
    const oldCheckout = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await db.payment.update({ where: { id: oldCheckout.paymentId }, data: { providerPayload: { stub: 'failed' } } });
    expect((await service.verifyPayment(workspaceId, oldCheckout.paymentId, {}, req)).status).toBe('FAILED');

    const newer = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'year' }, req);
    await service.verifyPayment(workspaceId, newer.paymentId, {}, req);
    const active = await db.subscription.findFirstOrThrow({ where: { workspaceId, status: 'ACTIVE' } });
    expect(await ledger.balance(walletId)).toBe(600);

    await db.payment.update({ where: { id: oldCheckout.paymentId }, data: { providerPayload: {} } });
    const gateway = registry.get('STUB')!;
    const verify = vi.spyOn(gateway, 'verify').mockResolvedValueOnce({
      ok: true,
      providerRef: `stub_old_late_${oldCheckout.paymentId}`,
      amountMinor: oldCheckout.amountMinor,
      currency: oldCheckout.currency,
      customerRef: 'stub-customer',
      subscriptionRef: `stub_old_subscription_${oldCheckout.paymentId}`,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000),
      raw: { late: true },
    });
    try {
      const late = await service.verifyPayment(workspaceId, oldCheckout.paymentId, {}, req);
      expect(late.status).toBe('NEEDS_REVIEW');
    } finally {
      verify.mockRestore();
    }

    expect(await ledger.balance(walletId)).toBe(600);
    expect(await db.subscription.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({
      id: active.id,
      interval: 'year',
      providerRef: active.providerRef,
    });
    expect(await db.refundRequest.findUniqueOrThrow({ where: { paymentId: oldCheckout.paymentId } })).toMatchObject({
      status: 'PROCESSING',
      requestedById: null,
    });
  });

  it('automatically refunds a legacy unbound checkout that pays after manual invoice settlement', async () => {
    const invoice = await invoiceFixture();
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', paidAt: new Date(), paidVia: 'MANUAL', paidReference: 'BANK-ALREADY-SETTLED', paymentId: null },
    });
    const stale = await db.payment.create({
      data: {
        workspaceId,
        userId,
        provider: 'STUB',
        kind: 'INVOICE',
        status: 'FAILED',
        reference: `as_inv_late_${crypto.randomUUID()}`,
        itemCode: invoice.number,
        credits: invoice.credits,
        amountMinor: invoice.totalMinor,
        currency: invoice.currency,
      },
    });

    const verified = await service.verifyPayment(workspaceId, stale.id, { providerRef: `stub_late_${stale.id}` }, req);
    expect(verified).toMatchObject({ status: 'NEEDS_REVIEW' });
    expect(verified.failureReason).toMatch(/already paid via MANUAL/);
    expect(await ledger.balance(walletId)).toBe(0);
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true, paymentId: true, paidReference: true } })).toEqual({
      status: 'PAID',
      paymentId: null,
      paidReference: 'BANK-ALREADY-SETTLED',
    });
    expect(await db.refundRequest.findUniqueOrThrow({ where: { paymentId: stale.id } })).toMatchObject({
      status: 'PROCESSING',
      requestedById: null,
      processingAt: null,
    });

    expect((await service.maintenanceTick(new Date(Date.now() + 1_000))).refundsCompleted).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('REFUNDED');
    expect(await ledger.balance(walletId)).toBe(0);
  });

  it('withholds a second invoice payment and durably refunds it without crediting the invoice twice', async () => {
    const invoice = await invoiceFixture();
    const bound = await db.payment.create({
      data: {
        workspaceId,
        userId,
        provider: 'STUB',
        kind: 'INVOICE',
        reference: `as_inv_bound_${crypto.randomUUID()}`,
        itemCode: invoice.number,
        credits: invoice.credits,
        amountMinor: invoice.totalMinor,
        currency: invoice.currency,
      },
    });
    await db.invoice.update({ where: { id: invoice.id }, data: { paymentId: bound.id } });
    const duplicate = await db.payment.create({
      data: {
        workspaceId,
        userId,
        provider: 'STUB',
        kind: 'INVOICE',
        reference: `as_inv_duplicate_${crypto.randomUUID()}`,
        itemCode: invoice.number,
        credits: invoice.credits,
        amountMinor: invoice.totalMinor,
        currency: invoice.currency,
      },
    });

    expect((await service.verifyPayment(workspaceId, duplicate.id, { providerRef: `stub_dup_${duplicate.id}` }, req)).status).toBe('NEEDS_REVIEW');
    expect(await ledger.balance(walletId)).toBe(0);
    const queued = await db.refundRequest.findUniqueOrThrow({ where: { paymentId: duplicate.id } });
    expect(queued).toMatchObject({ status: 'PROCESSING', processingAt: null, requestedById: null });

    const tick = await service.maintenanceTick(new Date(Date.now() + 1_000));
    expect(tick.refundsCompleted).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { id: duplicate.id } })).status).toBe('REFUNDED');
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).paymentId).toBe(bound.id);
    expect(await ledger.balance(walletId)).toBe(0);

    // Providers can emit a reversal as a second adjustment id. This duplicate
    // charge funded no credits, but its money aggregate still has to return to
    // zero rather than leaving the Payment falsely marked refunded.
    const confirmed = await db.refundRequest.findUniqueOrThrow({ where: { paymentId: duplicate.id } });
    const gateway = registry.get('STUB')!;
    const verify = vi.spyOn(gateway, 'verifyRefund').mockResolvedValueOnce({
      state: 'reversed',
      providerRef: `stub_reversal_${duplicate.id}`,
      amountMinor: duplicate.amountMinor,
      currency: duplicate.currency,
    });
    const reversalEvent = `evt_reversal_${duplicate.id}`;
    try {
      await service.handleWebhook('STUB', Buffer.from(JSON.stringify({ id: reversalEvent, type: 'refund', providerRef: `stub_dup_${duplicate.id}` })), {
        'x-stub-signature': 'stub',
      });
      await waitForOutcome(reversalEvent, 'refund_reversed');
    } finally {
      verify.mockRestore();
    }
    expect((await db.paymentAdjustment.aggregate({ where: { paymentId: duplicate.id }, _sum: { amountDeltaMinor: true } }))._sum.amountDeltaMinor).toBe(0);
    expect((await db.payment.findUniqueOrThrow({ where: { id: duplicate.id } })).status).toBe('NEEDS_REVIEW');
    expect(await db.refundRequest.findUniqueOrThrow({ where: { id: confirmed.id } })).toMatchObject({
      status: 'PROCESSING',
      gatewayRef: null,
      processingAt: null,
    });
    expect(await ledger.balance(walletId)).toBe(0);

    const retried = await service.maintenanceTick(new Date(Date.now() + 1_000));
    expect(retried.refundsCompleted).toBeGreaterThanOrEqual(1);
    expect((await db.payment.findUniqueOrThrow({ where: { id: duplicate.id } })).status).toBe('REFUNDED');
  });

  it('a plan: creates the subscription, refuses a second plan, renews from a gateway charge, cancels at period end', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'year' }, req);
    expect(out.amountMinor).toBe(12_000_000);
    const reused = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'year' }, req);
    expect(reused.paymentId).toBe(out.paymentId);
    await expect(service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req)).rejects.toMatchObject({ status: 409 });
    expect(await db.payment.count({ where: { workspaceId, kind: 'SUBSCRIPTION', status: 'PENDING' } })).toBe(1);
    await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    const sub = await service.subscription(workspaceId);
    expect(sub).toMatchObject({ planCode: 'test.plan', interval: 'year', status: 'ACTIVE' });
    expect(await ledger.balance(walletId)).toBe(600);
    await expect(service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan' }, req)).rejects.toMatchObject({ status: 409 });

    // The gateway renews: a charge we have no row for, on a subscription we know.
    // Paddle also repeats the original checkout reference on that charge.
    await db.workspace.update({ where: { id: workspaceId }, data: { currency: 'USD' } });
    const renew = JSON.stringify({
      id: 'evt_renew_' + workspaceId,
      type: 'charge',
      reference: out.reference,
      providerRef: `stub_renew_${out.paymentId}`,
      status: 'succeeded',
      subscriptionRef: `stubsub_${workspaceId.slice(0, 8)}`,
    });
    const r = await service.handleWebhook('STUB', Buffer.from(renew), { 'x-stub-signature': 'stub' });
    expect(r.status).toBe('accepted');
    await waitForOutcome('evt_renew_' + workspaceId, 'granted');
    expect(await ledger.balance(walletId)).toBe(1200);
    expect(await db.payment.count({ where: { workspaceId, kind: 'RENEWAL', status: 'SUCCEEDED' } })).toBe(1);
    expect(await db.payment.findFirst({ where: { workspaceId, kind: 'RENEWAL' }, select: { amountMinor: true, currency: true } })).toEqual({
      amountMinor: 12_000_000,
      currency: 'NGN',
    });

    const cancelled = await service.cancelSubscription(actor(), workspaceId, req);
    expect(cancelled.cancelAtPeriodEnd).toBe(true);
    expect(cancelled.cancellationPending).toBe(false);
    const gone = JSON.stringify({
      id: 'evt_cancel_' + workspaceId,
      type: 'subscription',
      subscriptionRef: `stubsub_${workspaceId.slice(0, 8)}`,
      subStatus: 'cancelled',
    });
    await service.handleWebhook('STUB', Buffer.from(gone), { 'x-stub-signature': 'stub' });
    await waitForOutcome('evt_cancel_' + workspaceId, 'subscription_cancelled');
    expect(await service.subscription(workspaceId)).toBeNull();
    expect(await db.subscription.findFirstOrThrow({ where: { workspaceId }, select: { status: true, cancelAtPeriodEnd: true } })).toEqual({
      status: 'CANCELLED',
      cancelAtPeriodEnd: false,
    });
  });

  it('does not let a delayed failed renewal regress a newer paid provider occurrence', async () => {
    const checkout = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, checkout.paymentId, {}, req);
    const subscription = await db.subscription.findFirstOrThrow({ where: { workspaceId, status: 'ACTIVE' } });
    const suffix = crypto.randomUUID();
    const paidRef = `stub_renew_paid_${suffix}`;
    const staleRef = `stub_renew_stale_${suffix}`;
    const paidStart = fromNow(60);
    const paidEnd = fromNow(90);
    const gateway = registry.get('STUB')!;
    const verify = vi.spyOn(gateway, 'verify').mockImplementation(async (payment, hint) => {
      if (hint?.providerRef === staleRef) {
        return {
          ok: false,
          state: 'failed',
          reason: 'provider declined an older billing attempt',
          raw: { created_at: fromNow(30).toISOString() },
        };
      }
      if (hint?.providerRef === paidRef) {
        return {
          ok: true,
          providerRef: paidRef,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          customerRef: subscription.customerRef ?? undefined,
          subscriptionRef: subscription.providerRef ?? undefined,
          periodStart: paidStart,
          periodEnd: paidEnd,
          raw: { created_at: new Date(paidStart.getTime() + 1_000).toISOString() },
        };
      }
      throw new Error(`unexpected verification ${hint?.providerRef ?? payment.id}`);
    });
    try {
      const paidEvent = `evt_renew_paid_${suffix}`;
      await service.handleWebhook(
        'STUB',
        Buffer.from(
          JSON.stringify({
            id: paidEvent,
            type: 'charge',
            providerRef: paidRef,
            status: 'succeeded',
            subscriptionRef: subscription.providerRef,
          }),
        ),
        { 'x-stub-signature': 'stub' },
      );
      await waitForOutcome(paidEvent, 'granted');

      const staleEvent = `evt_renew_stale_${suffix}`;
      await service.handleWebhook(
        'STUB',
        Buffer.from(
          JSON.stringify({
            id: staleEvent,
            type: 'charge',
            providerRef: staleRef,
            status: 'failed',
            subscriptionRef: subscription.providerRef,
          }),
        ),
        { 'x-stub-signature': 'stub' },
      );
      await waitForOutcome(staleEvent, 'failed');
    } finally {
      verify.mockRestore();
    }

    expect(await db.payment.findFirstOrThrow({ where: { provider: 'STUB', providerRef: staleRef }, select: { status: true } })).toEqual({ status: 'FAILED' });
    expect(
      await db.subscription.findUniqueOrThrow({ where: { id: subscription.id }, select: { status: true, currentPeriodStart: true, currentPeriodEnd: true } }),
    ).toEqual({
      status: 'ACTIVE',
      currentPeriodStart: paidStart,
      currentPeriodEnd: paidEnd,
    });
  });

  it('serializes a failed renewal with a newer settlement and keeps the paid period active', async () => {
    const checkout = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, checkout.paymentId, {}, req);
    const subscription = await db.subscription.findFirstOrThrow({ where: { workspaceId, status: 'ACTIVE' } });
    const suffix = crypto.randomUUID();
    const failedRef = `stub_renew_race_failed_${suffix}`;
    const paidRef = `stub_renew_race_paid_${suffix}`;
    const periodStart = fromNow(120);
    const periodEnd = fromNow(150);
    let releaseFailure!: () => void;
    const failureHeld = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let failureStarted!: () => void;
    const failedPaymentCreated = new Promise<void>((resolve) => {
      failureStarted = resolve;
    });
    const gateway = registry.get('STUB')!;
    const verify = vi.spyOn(gateway, 'verify').mockImplementation(async (payment, hint) => {
      if (hint?.providerRef === failedRef) {
        failureStarted();
        await failureHeld;
        return {
          ok: false,
          state: 'failed',
          reason: 'same-period retry declined',
          raw: {
            created_at: new Date(periodStart.getTime() + 1_000).toISOString(),
            billing_period: { starts_at: periodStart.toISOString(), ends_at: periodEnd.toISOString() },
          },
        };
      }
      if (hint?.providerRef === paidRef) {
        return {
          ok: true,
          providerRef: paidRef,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          customerRef: subscription.customerRef ?? undefined,
          subscriptionRef: subscription.providerRef ?? undefined,
          periodStart,
          periodEnd,
          raw: { created_at: new Date(periodStart.getTime() + 2_000).toISOString() },
        };
      }
      throw new Error(`unexpected verification ${hint?.providerRef ?? payment.id}`);
    });

    const failedEvent = `evt_renew_race_failed_${suffix}`;
    const paidEvent = `evt_renew_race_paid_${suffix}`;
    try {
      await service.handleWebhook(
        'STUB',
        Buffer.from(
          JSON.stringify({
            id: failedEvent,
            type: 'charge',
            providerRef: failedRef,
            status: 'failed',
            subscriptionRef: subscription.providerRef,
          }),
        ),
        { 'x-stub-signature': 'stub' },
      );
      await failedPaymentCreated;
      expect(await db.payment.findFirstOrThrow({ where: { provider: 'STUB', providerRef: failedRef }, select: { status: true } })).toEqual({
        status: 'PENDING',
      });

      await service.handleWebhook(
        'STUB',
        Buffer.from(
          JSON.stringify({
            id: paidEvent,
            type: 'charge',
            providerRef: paidRef,
            status: 'succeeded',
            subscriptionRef: subscription.providerRef,
          }),
        ),
        { 'x-stub-signature': 'stub' },
      );
      await waitForOutcome(paidEvent, 'granted');
      releaseFailure();
      await waitForOutcome(failedEvent, 'failed');
    } finally {
      releaseFailure();
      verify.mockRestore();
    }

    expect(await db.subscription.findUniqueOrThrow({ where: { id: subscription.id }, select: { status: true, currentPeriodEnd: true } })).toEqual({
      status: 'ACTIVE',
      currentPeriodEnd: periodEnd,
    });
    expect(await db.payment.findFirstOrThrow({ where: { provider: 'STUB', providerRef: failedRef }, select: { status: true } })).toEqual({ status: 'FAILED' });
    expect(await db.payment.findFirstOrThrow({ where: { provider: 'STUB', providerRef: paidRef }, select: { status: true } })).toEqual({ status: 'SUCCEEDED' });
  });

  it('marks a subscription past due when a verified failure belongs to the next provider period', async () => {
    const checkout = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, checkout.paymentId, {}, req);
    const subscription = await db.subscription.findFirstOrThrow({ where: { workspaceId, status: 'ACTIVE' } });
    const suffix = crypto.randomUUID();
    const paidRef = `stub_renew_before_failure_${suffix}`;
    const failedRef = `stub_renew_current_failure_${suffix}`;
    const paidStart = fromNow(180);
    const paidEnd = fromNow(210);
    const failedEnd = fromNow(240);
    const gateway = registry.get('STUB')!;
    const verify = vi.spyOn(gateway, 'verify').mockImplementation(async (payment, hint) => {
      if (hint?.providerRef === paidRef) {
        return {
          ok: true,
          providerRef: paidRef,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          customerRef: subscription.customerRef ?? undefined,
          subscriptionRef: subscription.providerRef ?? undefined,
          periodStart: paidStart,
          periodEnd: paidEnd,
          raw: { created_at: new Date(paidStart.getTime() + 1_000).toISOString() },
        };
      }
      if (hint?.providerRef === failedRef) {
        return {
          ok: false,
          state: 'failed',
          reason: 'next period renewal declined',
          raw: {
            created_at: new Date(paidEnd.getTime() + 1_000).toISOString(),
            billing_period: { starts_at: paidEnd.toISOString(), ends_at: failedEnd.toISOString() },
          },
        };
      }
      throw new Error(`unexpected verification ${hint?.providerRef ?? payment.id}`);
    });
    try {
      const paidEvent = `evt_renew_before_failure_${suffix}`;
      await service.handleWebhook(
        'STUB',
        Buffer.from(JSON.stringify({ id: paidEvent, type: 'charge', providerRef: paidRef, status: 'succeeded', subscriptionRef: subscription.providerRef })),
        { 'x-stub-signature': 'stub' },
      );
      await waitForOutcome(paidEvent, 'granted');

      const failedEvent = `evt_renew_current_failure_${suffix}`;
      await service.handleWebhook(
        'STUB',
        Buffer.from(JSON.stringify({ id: failedEvent, type: 'charge', providerRef: failedRef, status: 'failed', subscriptionRef: subscription.providerRef })),
        { 'x-stub-signature': 'stub' },
      );
      await waitForOutcome(failedEvent, 'failed');
    } finally {
      verify.mockRestore();
    }

    expect(await db.subscription.findUniqueOrThrow({ where: { id: subscription.id }, select: { status: true, currentPeriodEnd: true } })).toEqual({
      status: 'PAST_DUE',
      currentPeriodEnd: paidEnd,
    });
  });

  it('grants delayed renewal credits without overwriting a newer provider status, then accepts a newer success', async () => {
    const checkout = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, checkout.paymentId, {}, req);
    const original = await db.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
    const subscription = await db.subscription.findUniqueOrThrow({ where: { id: original.subscriptionId! } });
    const paidPeriodStart = fromNow(270);
    const paidPeriodEnd = fromNow(300);
    const providerStatusAt = fromNow(301);
    await db.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'PAST_DUE',
        currentPeriodStart: paidPeriodStart,
        currentPeriodEnd: paidPeriodEnd,
        providerUpdatedAt: providerStatusAt,
      },
    });
    const settle = (
      service as unknown as {
        settle(row: Payment, result: Extract<Verification, { ok: true }>, via: 'webhook'): Promise<Payment>;
      }
    ).settle.bind(service);
    const createRenewal = (providerRef: string) =>
      db.payment.create({
        data: {
          workspaceId,
          provider: 'STUB',
          kind: 'RENEWAL',
          reference: `as_renew_status_${crypto.randomUUID()}`,
          providerRef,
          itemCode: original.itemCode,
          interval: original.interval,
          credits: original.credits,
          amountMinor: original.amountMinor,
          currency: original.currency,
          subscriptionId: subscription.id,
          providerPayload: {
            subscriptionRef: subscription.providerRef,
            customerRef: subscription.customerRef,
          },
        },
      });

    const staleRef = `stub_stale_success_${crypto.randomUUID()}`;
    const stale = await createRenewal(staleRef);
    await settle(
      stale,
      {
        ok: true,
        providerRef: staleRef,
        amountMinor: stale.amountMinor,
        currency: stale.currency,
        subscriptionRef: subscription.providerRef ?? undefined,
        // No provider billing_period: the fallback must use this transaction
        // time, not the much later webhook receipt time.
        raw: { created_at: paidPeriodStart.toISOString() },
      },
      'webhook',
    );
    expect(
      await db.subscription.findUniqueOrThrow({ where: { id: subscription.id }, select: { status: true, providerUpdatedAt: true, currentPeriodEnd: true } }),
    ).toEqual({ status: 'PAST_DUE', providerUpdatedAt: providerStatusAt, currentPeriodEnd: paidPeriodEnd });

    const newerRef = `stub_newer_success_${crypto.randomUUID()}`;
    const newer = await createRenewal(newerRef);
    const newerStart = fromNow(330);
    const newerEnd = fromNow(360);
    await settle(
      newer,
      {
        ok: true,
        providerRef: newerRef,
        amountMinor: newer.amountMinor,
        currency: newer.currency,
        subscriptionRef: subscription.providerRef ?? undefined,
        periodStart: newerStart,
        periodEnd: newerEnd,
        raw: { created_at: newerStart.toISOString() },
      },
      'webhook',
    );
    expect(
      await db.subscription.findUniqueOrThrow({
        where: { id: subscription.id },
        select: { status: true, providerUpdatedAt: true, currentPeriodStart: true, currentPeriodEnd: true },
      }),
    ).toEqual({ status: 'ACTIVE', providerUpdatedAt: newerStart, currentPeriodStart: newerStart, currentPeriodEnd: newerEnd });
    expect(await ledger.balance(walletId)).toBe(1800);
  });

  it('applies newer provider status without moving a paid subscription period backwards', async () => {
    const checkout = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, checkout.paymentId, {}, req);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
    const subscription = await db.subscription.findUniqueOrThrow({ where: { id: payment.subscriptionId! } });
    const paidStart = fromNow(390);
    const paidEnd = fromNow(420);
    const previousProviderEvent = new Date(paidStart.getTime() + 1_000);
    await db.subscription.update({
      where: { id: subscription.id },
      data: { currentPeriodStart: paidStart, currentPeriodEnd: paidEnd, providerUpdatedAt: previousProviderEvent },
    });
    const act = (
      service as unknown as {
        act(gateway: Gateway, intent: WebhookIntent): Promise<string>;
      }
    ).act.bind(service);
    const newerEvent = fromNow(421);
    const outcome = await act(registry.get('STUB')!, {
      kind: 'subscription',
      subscriptionRef: subscription.providerRef ?? undefined,
      status: 'past_due',
      periodStart: fromNow(360),
      periodEnd: fromNow(390),
      occurredAt: newerEvent,
    });

    expect(outcome).toBe('subscription_past_due');
    expect(
      await db.subscription.findUniqueOrThrow({
        where: { id: subscription.id },
        select: { status: true, providerUpdatedAt: true, currentPeriodStart: true, currentPeriodEnd: true },
      }),
    ).toEqual({ status: 'PAST_DUE', providerUpdatedAt: newerEvent, currentPeriodStart: paidStart, currentPeriodEnd: paidEnd });

    const stale = await act(registry.get('STUB')!, {
      kind: 'subscription',
      subscriptionRef: subscription.providerRef ?? undefined,
      status: 'active',
      periodEnd: fromNow(405),
      occurredAt: fromNow(420),
    });
    expect(stale).toBe('subscription_stale');
    expect(await db.subscription.findUniqueOrThrow({ where: { id: subscription.id }, select: { status: true, currentPeriodEnd: true } })).toEqual({
      status: 'PAST_DUE',
      currentPeriodEnd: paidEnd,
    });
  });

  it('does not cancel the current subscription for an adjustment against its original period', async () => {
    const checkout = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, checkout.paymentId, {}, req);
    const original = await db.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
    const subscription = await db.subscription.findUniqueOrThrow({ where: { id: original.subscriptionId! } });
    const renewal = await db.payment.create({
      data: {
        workspaceId,
        provider: 'STUB',
        kind: 'RENEWAL',
        reference: `as_renew_adjustment_${crypto.randomUUID()}`,
        providerRef: `stub_renew_adjustment_${crypto.randomUUID()}`,
        itemCode: original.itemCode,
        interval: original.interval,
        credits: original.credits,
        amountMinor: original.amountMinor,
        currency: original.currency,
        subscriptionId: subscription.id,
        providerPayload: { subscriptionRef: subscription.providerRef },
      },
    });
    const settle = (
      service as unknown as {
        settle(row: Payment, result: Extract<Verification, { ok: true }>, via: 'webhook'): Promise<Payment>;
      }
    ).settle.bind(service);
    const renewalStart = fromNow(450);
    const renewalEnd = fromNow(480);
    await settle(
      renewal,
      {
        ok: true,
        providerRef: renewal.providerRef!,
        amountMinor: renewal.amountMinor,
        currency: renewal.currency,
        subscriptionRef: subscription.providerRef ?? undefined,
        periodStart: renewalStart,
        periodEnd: renewalEnd,
        raw: { created_at: renewalStart.toISOString() },
      },
      'webhook',
    );
    const adjustment = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
          reason: 'refund' | 'chargeback',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);
    await adjustment(
      await db.payment.findUniqueOrThrow({ where: { id: renewal.id } }),
      {
        state: 'succeeded',
        providerRef: `stub_current_period_partial_${crypto.randomUUID()}`,
        amountMinor: Math.floor(renewal.amountMinor / 2),
        currency: renewal.currency,
      },
      'refund',
    );
    expect(await db.payment.findUniqueOrThrow({ where: { id: renewal.id }, select: { status: true, ledgerEntryId: true } })).toMatchObject({
      status: 'NEEDS_REVIEW',
      ledgerEntryId: expect.any(String),
    });
    const outcome = await adjustment(
      original,
      {
        state: 'succeeded',
        providerRef: `stub_old_period_chargeback_${crypto.randomUUID()}`,
        amountMinor: original.amountMinor,
        currency: original.currency,
      },
      'chargeback',
    );

    expect(outcome).toBe('chargeback_confirmed');
    expect(
      await db.subscription.findUniqueOrThrow({
        where: { id: subscription.id },
        select: { status: true, providerCancelPending: true, currentPeriodEnd: true },
      }),
    ).toEqual({ status: 'ACTIVE', providerCancelPending: false, currentPeriodEnd: renewalEnd });
    expect(await ledger.balance(walletId)).toBe(300);
  });

  it('does not treat an unfulfilled failed renewal as a competing paid period', async () => {
    const checkout = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, checkout.paymentId, {}, req);
    const original = await db.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
    await db.payment.create({
      data: {
        workspaceId,
        provider: 'STUB',
        kind: 'RENEWAL',
        status: 'FAILED',
        reference: `as_failed_competitor_${crypto.randomUUID()}`,
        providerRef: `stub_failed_competitor_${crypto.randomUUID()}`,
        itemCode: original.itemCode,
        interval: original.interval,
        credits: original.credits,
        amountMinor: original.amountMinor,
        currency: original.currency,
        subscriptionId: original.subscriptionId,
        providerPayload: { verification: { created_at: fromNow(500).toISOString() } },
      },
    });
    const adjustment = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
          reason: 'chargeback',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);
    await adjustment(
      original,
      {
        state: 'succeeded',
        providerRef: `stub_current_period_chargeback_${crypto.randomUUID()}`,
        amountMinor: original.amountMinor,
        currency: original.currency,
      },
      'chargeback',
    );

    expect(await db.subscription.findUniqueOrThrow({ where: { id: original.subscriptionId! }, select: { status: true, providerCancelPending: true } })).toEqual(
      {
        status: 'CANCELLED',
        providerCancelPending: true,
      },
    );
  });

  it('verifies and fulfils a pending renewal before atomically applying its chargeback', async () => {
    const checkout = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, checkout.paymentId, {}, req);
    const original = await db.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
    const subscription = await db.subscription.findUniqueOrThrow({ where: { id: original.subscriptionId! } });
    const pending = await db.payment.create({
      data: {
        workspaceId,
        provider: 'STUB',
        kind: 'RENEWAL',
        status: 'PENDING',
        reference: `as_pending_adjustment_${crypto.randomUUID()}`,
        providerRef: `stub_pending_adjustment_${crypto.randomUUID()}`,
        itemCode: original.itemCode,
        interval: original.interval,
        credits: original.credits,
        amountMinor: original.amountMinor,
        currency: original.currency,
        subscriptionId: subscription.id,
        providerPayload: {
          renewalTiming: {
            periodStart: fromNow(30).toISOString(),
            periodEnd: fromNow(60).toISOString(),
          },
        },
      },
    });

    const outcome = await (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
          reason: 'chargeback',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment(
      pending,
      {
        state: 'succeeded',
        providerRef: `stub_pending_chargeback_${crypto.randomUUID()}`,
        amountMinor: pending.amountMinor,
        currency: pending.currency,
      },
      'chargeback',
    );

    expect(outcome).toBe('chargeback_confirmed');
    expect(await db.subscription.findUniqueOrThrow({ where: { id: subscription.id }, select: { status: true, providerCancelPending: true } })).toEqual({
      status: 'CANCELLED',
      providerCancelPending: true,
    });
    expect(await ledger.balance(walletId)).toBe(original.credits);
    expect(await db.payment.findUniqueOrThrow({ where: { id: pending.id }, select: { status: true, ledgerEntryId: true } })).toMatchObject({
      status: 'REFUNDED',
      ledgerEntryId: expect.any(String),
    });
  });

  it('does not cancel an active subscription when a standalone chargeback is reversed', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } });
    const subscription = await db.subscription.findUniqueOrThrow({ where: { id: payment.subscriptionId! } });

    const outcome = await (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'reversed'; providerRef: string; amountMinor: number; currency: string },
          reason: 'chargeback',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment(
      payment,
      {
        state: 'reversed',
        providerRef: `stub_chargeback_reversed_${payment.id}`,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      },
      'chargeback',
    );

    expect(outcome).toBe('refund_reversed');
    expect(
      await db.subscription.findUniqueOrThrow({
        where: { id: subscription.id },
        select: { status: true, providerCancelPending: true, cancelledAt: true },
      }),
    ).toEqual({ status: 'ACTIVE', providerCancelPending: false, cancelledAt: null });
  });

  it('queues cancellation for a legacy refunded initial charge without granting or refunding again', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    const payment = await db.payment.update({ where: { id: out.paymentId }, data: { status: 'REFUNDED', providerRef: `stub_legacy_${out.paymentId}` } });
    const act = (service as unknown as { act(gateway: Gateway, intent: WebhookIntent): Promise<string> }).act.bind(service);
    const intent: WebhookIntent = { kind: 'charge', providerRef: payment.providerRef!, status: 'succeeded' };
    expect(await act(registry.get('STUB')!, intent)).toBe('refunded_subscription_cancel_queued');
    expect(await act(registry.get('STUB')!, intent)).toBe('already_settled');
    expect(await db.subscription.findFirstOrThrow({ where: { workspaceId } })).toMatchObject({ status: 'CANCELLED', providerCancelPending: true });
    expect(await ledger.balance(walletId)).toBe(0);
    expect(await db.refundRequest.count({ where: { paymentId: payment.id } })).toBe(0);
  });

  it.each(['credit', 'credit_reverse'])('preserves unsupported Paddle %s for invoice review without cash movement', async (providerAction) => {
    const invoice = await invoiceFixture();
    const opened = await service.payInvoice(actor(), workspaceId, invoice.id, req);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: opened.paymentId } });
    const apply = (
      service as unknown as { applyRefundVerification(payment: Payment, verification: RefundVerification, reason: 'refund'): Promise<string> }
    ).applyRefundVerification.bind(service);
    expect(
      await apply(
        payment,
        { state: 'succeeded', providerRef: `adj_${providerAction}_${payment.id}`, providerAction, amountMinor: 100, currency: payment.currency },
        'refund',
      ),
    ).toBe('adjustment_needs_review');
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: 'NEEDS_REVIEW' });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: 'DISPUTED' });
    expect(await db.paymentAdjustment.findFirstOrThrow({ where: { paymentId: payment.id } })).toMatchObject({
      status: 'NEEDS_REVIEW',
      amountDeltaMinor: 0,
      creditDelta: 0,
    });
    expect(await ledger.balance(walletId)).toBe(0);
  });

  it('settles a subscription charge before applying its early chargeback in the same transaction', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } });
    const adjustmentRef = `stub_chargeback_early_${payment.id}`;
    const adjustment = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded' | 'reversed'; providerRef: string; amountMinor: number; currency: string },
          reason: 'chargeback',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);
    const withheld = await adjustment(
      payment,
      {
        state: 'succeeded',
        providerRef: adjustmentRef,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      },
      'chargeback',
    );
    expect(withheld).toBe('chargeback_confirmed');
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true, ledgerEntryId: true } })).toMatchObject({
      status: 'REFUNDED',
      ledgerEntryId: expect.any(String),
    });
    expect(await db.subscription.findFirstOrThrow({ where: { workspaceId }, select: { status: true, providerCancelPending: true } })).toEqual({
      status: 'CANCELLED',
      providerCancelPending: true,
    });
    expect(await ledger.balance(walletId)).toBe(0);
    expect(await db.ledgerEntry.count({ where: { walletId, idempotencyKey: `payment:${payment.id}` } })).toBe(1);
    expect(await db.paymentAdjustment.count({ where: { paymentId: payment.id, status: 'SUCCEEDED' } })).toBe(1);
  });

  it('durably records a cancellation when the provider cannot be called yet', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    const sub = await db.subscription.findFirstOrThrow({ where: { workspaceId, status: 'ACTIVE' } });
    await db.subscription.update({ where: { id: sub.id }, data: { providerRef: null } });

    const missingReference = await service.cancelSubscription(actor(), workspaceId, req);
    expect(missingReference).toMatchObject({ cancelAtPeriodEnd: true, cancellationPending: true });
    await db.subscription.update({ where: { id: sub.id }, data: { providerRef: sub.providerRef } });
    const configured = vi.spyOn(registry, 'get').mockReturnValue(null);
    try {
      const missingGateway = await service.cancelSubscription(actor(), workspaceId, req);
      expect(missingGateway).toMatchObject({ cancelAtPeriodEnd: true, cancellationPending: true });
    } finally {
      configured.mockRestore();
    }
    expect(
      await db.subscription.findUnique({
        where: { id: sub.id },
        select: { cancelAtPeriodEnd: true, cancelledAt: true, providerCancelPending: true, providerCancelError: true },
      }),
    ).toMatchObject({
      cancelAtPeriodEnd: true,
      providerCancelPending: true,
      providerCancelError: 'payment gateway is not configured',
    });
  });

  it('retries a saved provider cancellation after an ambiguous failure', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    const gateway = registry.get('STUB')!;
    const cancel = vi.spyOn(gateway, 'cancelSubscription').mockRejectedValueOnce(new Error('connection reset after request'));

    const scheduled = await service.cancelSubscription(actor(), workspaceId, req);
    expect(scheduled).toMatchObject({ cancelAtPeriodEnd: true, cancellationPending: true });

    const tick = await service.maintenanceTick(new Date(Date.now() + 16 * 60_000));
    expect(tick.providerCancellations).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(await db.subscription.findFirstOrThrow({ where: { workspaceId }, select: { providerCancelPending: true } })).toEqual({
      providerCancelPending: false,
    });
  });

  it('a refund takes the credits back once, and a refund after they were spent is recorded for a person', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_r1_${out.paymentId}` }, req);
    expect(await ledger.balance(walletId)).toBe(200);
    const refundEvent = 'evt_refund_' + out.reference;
    const refund = JSON.stringify({ id: refundEvent, type: 'refund', providerRef: `stub_r1_${out.paymentId}` });
    expect((await service.handleWebhook('STUB', Buffer.from(refund), { 'x-stub-signature': 'stub' })).status).toBe('accepted');
    await waitForOutcome(refundEvent, 'refunded');
    expect(await ledger.balance(walletId)).toBe(0);
    expect((await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).status).toBe('REFUNDED');

    const again = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, again.paymentId, { providerRef: `stub_r2_${again.paymentId}` }, req);
    await ledger.debit({ walletId, amount: 150, idempotencyKey: `spend-${again.paymentId}` });
    const secondRefundEvent = 'evt_refund_' + again.reference;
    const r = await service.handleWebhook(
      'STUB',
      Buffer.from(JSON.stringify({ id: secondRefundEvent, type: 'refund', providerRef: `stub_r2_${again.paymentId}` })),
      {
        'x-stub-signature': 'stub',
      },
    );
    expect(r.status).toBe('accepted');
    await waitForOutcome(secondRefundEvent, 'refunded');
    expect(await ledger.balance(walletId)).toBe(-150);
  });

  it('records a partial provider adjustment once and claws back only proportional credits', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_partial_${out.paymentId}` }, req);
    const gateway = registry.get('STUB')!;
    const verify = vi.spyOn(gateway, 'verifyRefund').mockResolvedValue({
      state: 'succeeded',
      providerRef: `stubadjust_partial_${out.paymentId}`,
      amountMinor: out.amountMinor / 2,
      currency: out.currency,
    });
    const eventId = `evt_partial_${out.reference}`;
    const body = Buffer.from(JSON.stringify({ id: eventId, type: 'refund', providerRef: `stub_partial_${out.paymentId}` }));
    try {
      await service.handleWebhook('STUB', body, { 'x-stub-signature': 'stub' });
      await waitForOutcome(eventId, 'partial_adjustment_recorded');
      expect(await ledger.balance(walletId)).toBe(100);
      expect((await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).status).toBe('NEEDS_REVIEW');
      expect(
        await db.paymentAdjustment.findUniqueOrThrow({
          where: { provider_providerRef: { provider: 'STUB', providerRef: `stubadjust_partial_${out.paymentId}` } },
          select: { status: true, amountDeltaMinor: true, creditDelta: true, ledgerRevision: true },
        }),
      ).toEqual({ status: 'SUCCEEDED', amountDeltaMinor: -(out.amountMinor / 2), creditDelta: -100, ledgerRevision: 1 });

      await service.handleWebhook('STUB', body, { 'x-stub-signature': 'stub' });
      expect(await ledger.balance(walletId)).toBe(100);

      verify.mockResolvedValue({
        state: 'succeeded',
        providerRef: `stubadjust_partial_${out.paymentId}`,
        amountMinor: (out.amountMinor * 3) / 4,
        currency: out.currency,
      });
      const increasedId = `evt_partial_increased_${out.reference}`;
      await service.handleWebhook('STUB', Buffer.from(JSON.stringify({ id: increasedId, type: 'refund', providerRef: `stub_partial_${out.paymentId}` })), {
        'x-stub-signature': 'stub',
      });
      await waitForOutcome(increasedId, 'partial_adjustment_recorded');
      expect(await ledger.balance(walletId)).toBe(50);
      expect(
        await db.paymentAdjustment.findUniqueOrThrow({
          where: { provider_providerRef: { provider: 'STUB', providerRef: `stubadjust_partial_${out.paymentId}` } },
          select: { creditDelta: true, ledgerRevision: true },
        }),
      ).toEqual({ creditDelta: -150, ledgerRevision: 2 });

      verify.mockResolvedValue({
        state: 'reversed',
        providerRef: `stubadjust_partial_${out.paymentId}`,
        amountMinor: (out.amountMinor * 3) / 4,
        currency: out.currency,
      });
      const reversedId = `evt_partial_reversed_${out.reference}`;
      await service.handleWebhook('STUB', Buffer.from(JSON.stringify({ id: reversedId, type: 'refund', providerRef: `stub_partial_${out.paymentId}` })), {
        'x-stub-signature': 'stub',
      });
      await waitForOutcome(reversedId, 'refund_reversed');
      expect(await ledger.balance(walletId)).toBe(200);
      expect(
        await db.paymentAdjustment.findUniqueOrThrow({
          where: { provider_providerRef: { provider: 'STUB', providerRef: `stubadjust_partial_${out.paymentId}` } },
          select: { status: true, amountDeltaMinor: true, creditDelta: true, ledgerRevision: true },
        }),
      ).toEqual({ status: 'REVERSED', amountDeltaMinor: 0, creditDelta: 0, ledgerRevision: 3 });

      // An eventually-consistent provider read can lag behind the reversal.
      // The immutable adjustment id must remain terminal and cannot claw a
      // restored purchase a second time.
      const payment = await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } });
      const stale = await (
        service as unknown as {
          applyConfirmedAdjustment(
            payment: Payment,
            verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
            reason: 'refund',
          ): Promise<string>;
        }
      ).applyConfirmedAdjustment(
        payment,
        {
          state: 'succeeded',
          providerRef: `stubadjust_partial_${out.paymentId}`,
          amountMinor: (out.amountMinor * 3) / 4,
          currency: out.currency,
        },
        'refund',
      );
      expect(stale).toBe('refund_reversed');
      expect(await ledger.balance(walletId)).toBe(200);
    } finally {
      verify.mockRestore();
    }
  });

  it('does not overwrite a webhook-confirmed refund when the reconciliation retry limit races it', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_refund_race_${out.paymentId}` }, req);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } });
    const request = await db.refundRequest.create({
      data: {
        paymentId: payment.id,
        workspaceId,
        requestedById: userId,
        reason: 'race fixture',
        status: 'PROCESSING',
        balanceAtRequest: 200,
        attempts: 31,
        gatewayRef: `stub_refund_race_adjustment_${payment.id}`,
        processingAt: new Date(Date.now() - 60_000),
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
    });

    let claimReached!: () => void;
    let releaseClaim!: () => void;
    const claimed = new Promise<void>((resolve) => {
      claimReached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const updateMany = db.refundRequest.updateMany.bind(db.refundRequest);
    const claim = vi.spyOn(db.refundRequest, 'updateMany').mockImplementation(async (args) => {
      const result = await updateMany(args);
      if (args.where?.id === request.id && typeof args.data.attempts === 'object' && args.data.attempts && 'increment' in args.data.attempts) {
        claimReached();
        await released;
      }
      return result;
    });

    try {
      const maintenance = service.maintenanceTick();
      await claimed;
      const outcome = await (
        service as unknown as {
          applyConfirmedAdjustment(
            payment: Payment,
            verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
            reason: 'refund',
          ): Promise<string>;
        }
      ).applyConfirmedAdjustment(
        payment,
        {
          state: 'succeeded',
          providerRef: `stub_refund_race_adjustment_${payment.id}`,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
        },
        'refund',
      );
      expect(outcome).toBe('refunded');
      releaseClaim();
      await maintenance;
    } finally {
      releaseClaim();
      claim.mockRestore();
    }

    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true } })).toEqual({ status: 'REFUNDED' });
    expect(await db.refundRequest.findUniqueOrThrow({ where: { id: request.id }, select: { status: true } })).toEqual({ status: 'APPROVED' });
    expect(await ledger.balance(walletId)).toBe(0);
  });

  it('serializes duplicate customer refund requests into one durable row', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_request_race_${out.paymentId}` }, req);

    const attempts = await Promise.allSettled([
      service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'first tab' }, req),
      service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'second tab' }, req),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(await db.refundRequest.count({ where: { paymentId: out.paymentId, status: 'REQUESTED' } })).toBe(1);
  });

  it('serializes conflicting success and failure verification so credits and status cannot diverge', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    const gateway = registry.get('STUB')!;
    const verify = vi.spyOn(gateway, 'verify').mockImplementation(async (payment, hint) => {
      if (hint?.providerRef === 'late_failure') {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ok: false, state: 'failed', reason: 'late failure envelope' };
      }
      return {
        ok: true,
        providerRef: `winning_success_${out.paymentId}`,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        raw: { status: 'successful' },
      };
    });
    try {
      await Promise.all([
        service.verifyPayment(workspaceId, out.paymentId, { providerRef: 'late_failure' }, req),
        service.verifyPayment(workspaceId, out.paymentId, { providerRef: `winning_success_${out.paymentId}` }, req),
      ]);
      expect((await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).status).toBe('SUCCEEDED');
      expect(await ledger.balance(walletId)).toBe(200);
    } finally {
      verify.mockRestore();
    }
  });

  it('keeps an asynchronous refund processing until provider verification confirms it', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_async_${out.paymentId}` }, req);
    const requested = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'Please return this purchase' }, req);
    const gateway = registry.get('STUB')!;
    const start = vi.spyOn(gateway, 'refund').mockResolvedValueOnce({
      state: 'pending',
      providerRef: `stubrefund_async_${out.paymentId}`,
      amountMinor: out.amountMinor,
      currency: out.currency,
    });
    const verify = vi.spyOn(gateway, 'verifyRefund').mockResolvedValueOnce({
      state: 'succeeded',
      providerRef: `stubrefund_async_${out.paymentId}`,
      amountMinor: out.amountMinor,
      currency: out.currency,
    });
    try {
      const processing = await service.decideRefund(actor(), requested.id, true, '', req);
      expect(processing.status).toBe('PROCESSING');
      expect((await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).status).toBe('SUCCEEDED');
      expect(await ledger.balance(walletId)).toBe(0);

      const tick = await service.maintenanceTick(new Date(Date.now() + 16 * 60_000));
      expect(tick.refundsCompleted).toBe(1);
      expect((await db.refundRequest.findUniqueOrThrow({ where: { id: requested.id } })).status).toBe('APPROVED');
      expect((await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).status).toBe('REFUNDED');
      expect(await ledger.balance(walletId)).toBe(0);
    } finally {
      start.mockRestore();
      verify.mockRestore();
    }
  });

  it('releases reserved credits when the provider definitively rejects a refund', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_rejected_${out.paymentId}` }, req);
    const requested = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'Please return this purchase' }, req);
    const gateway = registry.get('STUB')!;
    const start = vi.spyOn(gateway, 'refund').mockResolvedValueOnce({
      state: 'failed',
      reason: 'provider says this transaction is not refundable',
      amountMinor: out.amountMinor,
      currency: out.currency,
    });
    try {
      const refused = await service.decideRefund(actor(), requested.id, true, '', req);
      expect(refused.status).toBe('REFUSED');
      expect((await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).status).toBe('SUCCEEDED');
      expect(await ledger.balance(walletId)).toBe(200);
    } finally {
      start.mockRestore();
    }
  });

  it('uses a new ledger reservation when a refused refund is reopened', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_cycle_${out.paymentId}` }, req);
    const gateway = registry.get('STUB')!;
    const refund = vi
      .spyOn(gateway, 'refund')
      .mockResolvedValueOnce({
        state: 'failed',
        providerRef: `stubrefund_rejected_${out.paymentId}`,
        reason: 'provider rejected cycle one',
        amountMinor: out.amountMinor,
        currency: out.currency,
      })
      .mockResolvedValueOnce({
        state: 'succeeded',
        providerRef: `stubrefund_cycle_two_${out.paymentId}`,
        amountMinor: out.amountMinor,
        currency: out.currency,
      });
    try {
      const first = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'first request' }, req);
      expect((await service.decideRefund(actor(), first.id, true, '', req)).status).toBe('REFUSED');
      expect(await ledger.balance(walletId)).toBe(200);

      const second = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'second request' }, req);
      expect(second.id).toBe(first.id);
      expect((await db.refundRequest.findUniqueOrThrow({ where: { id: second.id } })).refundCycle).toBe(2);
      expect((await service.decideRefund(actor(), second.id, true, '', req)).status).toBe('APPROVED');

      expect((await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).status).toBe('REFUNDED');
      expect(await ledger.balance(walletId)).toBe(0);
    } finally {
      refund.mockRestore();
    }
  });

  it('claws credits once when provider success arrives after a failed refund released its reservation', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_late_refund_${out.paymentId}` }, req);
    const gateway = registry.get('STUB')!;
    const adjustmentRef = `stubrefund_late_success_${out.paymentId}`;
    const refund = vi.spyOn(gateway, 'refund').mockResolvedValueOnce({
      state: 'failed',
      providerRef: adjustmentRef,
      reason: 'provider initially rejected it',
      amountMinor: out.amountMinor,
      currency: out.currency,
    });
    try {
      const requested = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'late provider result' }, req);
      expect((await service.decideRefund(actor(), requested.id, true, '', req)).status).toBe('REFUSED');
      expect(await ledger.balance(walletId)).toBe(200);

      const payment = await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } });
      const outcome = await (
        service as unknown as {
          applyConfirmedAdjustment(
            payment: Payment,
            verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
            reason: 'refund',
          ): Promise<string>;
        }
      ).applyConfirmedAdjustment(payment, { state: 'succeeded', providerRef: adjustmentRef, amountMinor: out.amountMinor, currency: out.currency }, 'refund');

      expect(outcome).toBe('refunded');
      expect(await ledger.balance(walletId)).toBe(0);
      expect((await db.refundRequest.findUniqueOrThrow({ where: { id: requested.id } })).status).toBe('APPROVED');
      expect(await db.ledgerEntry.count({ where: { walletId, idempotencyKey: { startsWith: 'payment-adjustment:' } } })).toBe(1);
    } finally {
      refund.mockRestore();
    }
  });

  it('binds a success webhook that wins the race with the refund POST response to the reserved cycle', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    const chargeRef = `stub_preack_charge_${out.paymentId}`;
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: chargeRef }, req);
    const requested = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'pre-ack webhook race' }, req);
    const adjustmentRef = `stubrefund_${chargeRef}`;
    const gateway = registry.get('STUB')!;
    let refundStarted!: () => void;
    let releaseRefund!: () => void;
    const started = new Promise<void>((resolve) => {
      refundStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseRefund = resolve;
    });
    const refund = vi.spyOn(gateway, 'refund').mockImplementationOnce(async () => {
      refundStarted();
      await held;
      return { state: 'succeeded', providerRef: adjustmentRef, amountMinor: out.amountMinor, currency: out.currency };
    });
    const verify = vi.spyOn(gateway, 'verifyRefund').mockResolvedValue({
      state: 'succeeded',
      providerRef: adjustmentRef,
      amountMinor: out.amountMinor,
      currency: out.currency,
    });

    try {
      const decision = service.decideRefund(actor(), requested.id, true, '', req);
      await started;
      expect(await ledger.balance(walletId)).toBe(0);
      const eventId = `evt_preack_${out.paymentId}`;
      expect(
        (
          await service.handleWebhook('STUB', Buffer.from(JSON.stringify({ id: eventId, type: 'refund', providerRef: chargeRef })), {
            'x-stub-signature': 'stub',
          })
        ).status,
      ).toBe('accepted');
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await db.webhookReceipt.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STUB', eventId } }, select: { outcome: true } })).toEqual({
        outcome: 'processing',
      });
      expect(await ledger.balance(walletId)).toBe(0);
      expect(await db.refundRequest.findUniqueOrThrow({ where: { id: requested.id } })).toMatchObject({
        status: 'PROCESSING',
        refundCycle: 1,
      });

      releaseRefund();
      await expect(decision).resolves.toMatchObject({ status: 'APPROVED' });
      await waitForOutcome(eventId, 'refunded');
      expect(
        await db.paymentAdjustment.findUniqueOrThrow({
          where: { provider_providerRef: { provider: 'STUB', providerRef: adjustmentRef } },
          select: { refundCycle: true, creditDelta: true },
        }),
      ).toEqual({ refundCycle: 1, creditDelta: -out.credits });
      expect(refund).toHaveBeenCalledTimes(1);
      expect(await ledger.balance(walletId)).toBe(0);
    } finally {
      releaseRefund();
      refund.mockRestore();
      verify.mockRestore();
    }
  });

  it('does not submit a refund when a chargeback finalizes the cycle after reservation but before the provider call', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_pre_submit_chargeback_${out.paymentId}` }, req);
    const requested = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'chargeback may race approval' }, req);
    const gateway = registry.get('STUB')!;
    const refund = vi.spyOn(gateway, 'refund').mockResolvedValue({
      state: 'succeeded',
      providerRef: `stubrefund_must_not_be_created_${out.paymentId}`,
      amountMinor: out.amountMinor,
      currency: out.currency,
    });
    let submissionReached!: () => void;
    let releaseSubmission!: () => void;
    const reached = new Promise<void>((resolve) => {
      submissionReached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });
    type SubmitRefundCycle = (
      gateway: Gateway,
      input: {
        paymentId: string;
        requestId: string;
        refundCycle: number;
        expectedAttempts: number;
        since: Date;
        reason: string;
        requireUnclaimed: boolean;
      },
    ) => Promise<{ payment: Payment; verification: RefundVerification } | null>;
    const internal = service as unknown as { submitRefundCycle: SubmitRefundCycle };
    const submitRefundCycle = internal.submitRefundCycle.bind(service);
    const submission = vi.spyOn(internal, 'submitRefundCycle').mockImplementationOnce(async (...args) => {
      submissionReached();
      await released;
      return submitRefundCycle(...args);
    });

    try {
      const decision = service.decideRefund(actor(), requested.id, true, '', req);
      await reached;
      const payment = await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } });
      const outcome = await (
        service as unknown as {
          applyConfirmedAdjustment(
            payment: Payment,
            verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
            reason: 'chargeback',
          ): Promise<string>;
        }
      ).applyConfirmedAdjustment(
        payment,
        {
          state: 'succeeded',
          providerRef: `stub_chargeback_pre_submit_winner_${out.paymentId}`,
          amountMinor: out.amountMinor,
          currency: out.currency,
        },
        'chargeback',
      );
      expect(outcome).toBe('chargeback_confirmed');
      releaseSubmission();
      await expect(decision).resolves.toMatchObject({ status: 'APPROVED' });
      expect(refund).not.toHaveBeenCalled();
      expect(await ledger.balance(walletId)).toBe(0);
    } finally {
      releaseSubmission();
      submission.mockRestore();
      refund.mockRestore();
    }
  });

  it('serializes a chargeback behind an in-flight refund rejection without submitting another refund', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_chargeback_race_${out.paymentId}` }, req);
    const requested = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'chargeback raced the refund' }, req);
    const gateway = registry.get('STUB')!;
    let refundStarted!: () => void;
    let releaseRefund!: () => void;
    const started = new Promise<void>((resolve) => {
      refundStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseRefund = resolve;
    });
    const refund = vi.spyOn(gateway, 'refund').mockImplementationOnce(async () => {
      refundStarted();
      await held;
      return {
        state: 'failed',
        providerRef: `stubrefund_rejected_after_chargeback_${out.paymentId}`,
        reason: 'already returned by chargeback',
        amountMinor: out.amountMinor,
        currency: out.currency,
      };
    });
    try {
      const decision = service.decideRefund(actor(), requested.id, true, '', req);
      await started;
      const adjustment = (
        service as unknown as {
          applyConfirmedAdjustment(
            payment: Payment,
            verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
            reason: 'chargeback',
          ): Promise<string>;
        }
      ).applyConfirmedAdjustment(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        {
          state: 'succeeded',
          providerRef: `stub_chargeback_winner_${out.paymentId}`,
          amountMinor: out.amountMinor,
          currency: out.currency,
        },
        'chargeback',
      );
      // The provider submission owns the Payment lock until its acknowledgement
      // is saved. Release it before awaiting the webhook that needs that lock.
      releaseRefund();
      const [outcome] = await Promise.all([adjustment, decision]);
      expect(outcome).toBe('chargeback_confirmed');
      expect(await ledger.balance(walletId)).toBe(0);
      expect(await db.refundRequest.findUniqueOrThrow({ where: { id: requested.id } })).toMatchObject({ status: 'REFUSED', refundCycle: 1 });
      await service.maintenanceTick(new Date(Date.now() + 24 * 60 * 60_000));
      expect(refund).toHaveBeenCalledTimes(1);
      expect(await ledger.balance(walletId)).toBe(0);
    } finally {
      releaseRefund();
      refund.mockRestore();
    }
  });

  it('does not let a delayed cycle-one success consume or approve the active cycle-two reservation', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_cycle_isolation_${out.paymentId}` }, req);
    const gateway = registry.get('STUB')!;
    const oldRef = `stubrefund_cycle_one_${out.paymentId}`;
    const currentRef = `stubrefund_cycle_two_pending_${out.paymentId}`;
    const refund = vi
      .spyOn(gateway, 'refund')
      .mockResolvedValueOnce({
        state: 'failed',
        providerRef: oldRef,
        reason: 'cycle one was initially rejected',
        amountMinor: out.amountMinor,
        currency: out.currency,
      })
      .mockResolvedValueOnce({ state: 'pending', providerRef: currentRef, amountMinor: out.amountMinor, currency: out.currency });
    try {
      const first = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'cycle one' }, req);
      expect((await service.decideRefund(actor(), first.id, true, '', req)).status).toBe('REFUSED');
      const second = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'cycle two' }, req);
      expect((await service.decideRefund(actor(), second.id, true, '', req)).status).toBe('PROCESSING');
      expect(await ledger.balance(walletId)).toBe(0);

      const payment = await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } });
      const confirmed = await (
        service as unknown as {
          applyConfirmedAdjustment(
            payment: Payment,
            verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
            reason: 'refund',
          ): Promise<string>;
        }
      ).applyConfirmedAdjustment(payment, { state: 'succeeded', providerRef: oldRef, amountMinor: out.amountMinor, currency: out.currency }, 'refund');
      expect(confirmed).toBe('refunded');
      expect(await db.refundRequest.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
        status: 'PROCESSING',
        refundCycle: 2,
        gatewayRef: currentRef,
      });
      expect(await ledger.balance(walletId)).toBe(-out.credits);

      const failed = await (
        service as unknown as {
          applyRefundVerification(
            payment: Payment,
            verification: { state: 'failed'; providerRef: string; amountMinor: number; currency: string; reason: string },
            reason: 'refund',
            cycle: { requestId: string; refundCycle: number },
          ): Promise<string>;
        }
      ).applyRefundVerification(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        {
          state: 'failed',
          providerRef: currentRef,
          amountMinor: out.amountMinor,
          currency: out.currency,
          reason: 'cycle two rejected',
        },
        'refund',
        { requestId: second.id, refundCycle: 2 },
      );
      expect(failed).toBe('refund_failed');
      expect(await db.refundRequest.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: 'REFUSED', refundCycle: 2 });
      expect(await ledger.balance(walletId)).toBe(0);
    } finally {
      refund.mockRestore();
    }
  });

  it('releases an exact customer cycle when definitive failure arrives after reconciliation exhaustion', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_exhaustion_${out.paymentId}` }, req);
    const requested = await service.requestRefund(actor(), workspaceId, out.paymentId, { reason: 'late rejection after retries' }, req);
    const adjustmentRef = `stubrefund_exhaustion_${out.paymentId}`;
    const gateway = registry.get('STUB')!;
    const refund = vi.spyOn(gateway, 'refund').mockResolvedValueOnce({
      state: 'pending',
      providerRef: adjustmentRef,
      amountMinor: out.amountMinor,
      currency: out.currency,
    });
    const exhausted = 'Provider refund could not be confirmed automatically after the retry limit; operator review required.';
    try {
      expect((await service.decideRefund(actor(), requested.id, true, '', req)).status).toBe('PROCESSING');
      await db.$transaction([
        db.refundRequest.update({
          where: { id: requested.id },
          data: { status: 'NEEDS_REVIEW', lastError: exhausted, decisionNote: exhausted, nextAttemptAt: null },
        }),
        db.payment.update({ where: { id: out.paymentId }, data: { status: 'NEEDS_REVIEW', failureReason: exhausted } }),
      ]);

      const outcome = await (
        service as unknown as {
          applyRefundVerification(
            payment: Payment,
            verification: { state: 'failed'; providerRef: string; amountMinor: number; currency: string; reason: string },
            reason: 'refund',
          ): Promise<string>;
        }
      ).applyRefundVerification(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        {
          state: 'failed',
          providerRef: adjustmentRef,
          amountMinor: out.amountMinor,
          currency: out.currency,
          reason: 'provider definitively rejected it',
        },
        'refund',
      );

      expect(outcome).toBe('refund_failed');
      expect(await db.refundRequest.findUniqueOrThrow({ where: { id: requested.id } })).toMatchObject({ status: 'REFUSED', refundCycle: 1 });
      expect(await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).toMatchObject({ status: 'SUCCEEDED', failureReason: null });
      expect(await ledger.balance(walletId)).toBe(out.credits);
    } finally {
      refund.mockRestore();
    }
  });

  it('marks aggregate provider over-return for review instead of approving a refund', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_overreturn_${out.paymentId}` }, req);
    const apply = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded'; providerRef: string; amountMinor: number; currency: string },
          reason: 'refund',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } });
    expect(
      await apply(payment, { state: 'succeeded', providerRef: `stub_overreturn_a_${out.paymentId}`, amountMinor: 300_000, currency: out.currency }, 'refund'),
    ).toBe('partial_adjustment_recorded');
    expect(
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        { state: 'succeeded', providerRef: `stub_overreturn_b_${out.paymentId}`, amountMinor: 300_000, currency: out.currency },
        'refund',
      ),
    ).toBe('adjustment_needs_review');

    expect(await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).toMatchObject({
      status: 'NEEDS_REVIEW',
      refundedAt: null,
      failureReason: expect.stringContaining('exceed the original charge'),
    });
    expect((await db.paymentAdjustment.aggregate({ where: { paymentId: out.paymentId }, _sum: { amountDeltaMinor: true } }))._sum.amountDeltaMinor).toBe(
      -600_000,
    );
  });

  it.each(['first', 'second'] as const)('derives withheld credits from aggregate money when reversing the %s over-return row', async (which) => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_aggregate_math_${out.paymentId}` }, req);
    const apply = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded' | 'reversed'; providerRef: string; amountMinor: number; currency: string },
          reason: 'refund',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);
    const refs = [`stub_aggregate_math_a_${out.paymentId}`, `stub_aggregate_math_b_${out.paymentId}`];
    for (const providerRef of refs) {
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        { state: 'succeeded', providerRef, amountMinor: 300_000, currency: out.currency },
        'refund',
      );
    }
    expect(await ledger.balance(walletId)).toBe(0);

    expect(
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        { state: 'reversed', providerRef: refs[which === 'first' ? 0 : 1]!, amountMinor: 300_000, currency: out.currency },
        'refund',
      ),
    ).toBe('refund_reversed');
    expect(
      await db.paymentAdjustment.aggregate({
        where: { paymentId: out.paymentId, status: { in: ['SUCCEEDED', 'REVERSED'] } },
        _sum: { amountDeltaMinor: true, creditDelta: true },
      }),
    ).toMatchObject({ _sum: { amountDeltaMinor: -300_000, creditDelta: -120 } });
    expect(await ledger.balance(walletId)).toBe(80);
  });

  it('preserves a positive reversal that arrives before its original adjustment and later converges both aggregates to zero', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_reverse_first_${out.paymentId}` }, req);
    const apply = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded' | 'reversed'; providerRef: string; amountMinor: number; currency: string },
          reason: 'refund',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);
    await apply(
      await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
      {
        state: 'reversed',
        providerRef: `stub_reverse_first_positive_${out.paymentId}`,
        amountMinor: out.amountMinor,
        currency: out.currency,
      },
      'refund',
    );
    expect(await db.paymentAdjustment.aggregate({ where: { paymentId: out.paymentId }, _sum: { amountDeltaMinor: true, creditDelta: true } })).toMatchObject({
      _sum: { amountDeltaMinor: out.amountMinor, creditDelta: 0 },
    });
    expect(await ledger.balance(walletId)).toBe(out.credits);

    await apply(
      await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
      {
        state: 'succeeded',
        providerRef: `stub_reverse_first_original_${out.paymentId}`,
        amountMinor: out.amountMinor,
        currency: out.currency,
      },
      'refund',
    );
    expect(await db.paymentAdjustment.aggregate({ where: { paymentId: out.paymentId }, _sum: { amountDeltaMinor: true, creditDelta: true } })).toMatchObject({
      _sum: { amountDeltaMinor: 0, creditDelta: 0 },
    });
    expect(await db.payment.findUniqueOrThrow({ where: { id: out.paymentId }, select: { status: true } })).toEqual({ status: 'SUCCEEDED' });
    expect(await ledger.balance(walletId)).toBe(out.credits);
  });

  it.each([
    ['original success → original reversed → separate reverse', ['original_succeeded', 'original_reversed', 'separate_reversed']],
    ['original success → separate reverse → original reversed', ['original_succeeded', 'separate_reversed', 'original_reversed']],
    ['original reversed → original success → separate reverse', ['original_reversed', 'original_succeeded', 'separate_reversed']],
    ['original reversed → separate reverse → original success', ['original_reversed', 'separate_reversed', 'original_succeeded']],
    ['separate reverse → original success → original reversed', ['separate_reversed', 'original_succeeded', 'original_reversed']],
    ['separate reverse → original reversed → original success', ['separate_reversed', 'original_reversed', 'original_succeeded']],
  ] as const)('counts Paddle dual reversal facts once for %s', async (_label, order) => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: `stub_paddle_dual_${out.paymentId}` }, req);
    const payment = await db.payment.update({ where: { id: out.paymentId }, data: { provider: 'PADDLE' } });
    const originalRef = `adj_paddle_original_${out.paymentId}`;
    const reverseRef = `adj_paddle_reverse_${out.paymentId}`;
    const apply = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: {
            state: 'succeeded' | 'reversed';
            providerRef: string;
            amountMinor: number;
            currency: string;
            providerAction: string;
            reversalMode: 'separate_adjustment';
          },
          reason: 'chargeback',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);

    for (const fact of order) {
      const original = fact.startsWith('original_');
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: payment.id } }),
        {
          state: fact === 'original_succeeded' ? 'succeeded' : 'reversed',
          providerRef: original ? originalRef : reverseRef,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          providerAction: original ? 'chargeback' : 'chargeback_reverse',
          reversalMode: 'separate_adjustment',
        },
        'chargeback',
      );
    }

    expect(
      await db.paymentAdjustment.aggregate({
        where: { paymentId: payment.id, status: { in: ['SUCCEEDED', 'REVERSED'] } },
        _sum: { amountDeltaMinor: true, creditDelta: true },
      }),
    ).toMatchObject({ _sum: { amountDeltaMinor: 0, creditDelta: 0 } });
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true } })).toEqual({ status: 'SUCCEEDED' });
    expect(await ledger.balance(walletId)).toBe(payment.credits);
    const [original, reverse] = await Promise.all([
      db.paymentAdjustment.findUniqueOrThrow({ where: { provider_providerRef: { provider: 'PADDLE', providerRef: originalRef } } }),
      db.paymentAdjustment.findUniqueOrThrow({ where: { provider_providerRef: { provider: 'PADDLE', providerRef: reverseRef } } }),
    ]);
    expect(original.payload).toMatchObject({
      providerAction: 'chargeback',
      reversalMode: 'separate_adjustment',
      economicReversedByProviderRef: reverseRef,
    });
    expect(reverse.payload).toMatchObject({
      providerAction: 'chargeback_reverse',
      reversalMode: 'separate_adjustment',
      economicReversalOfAction: 'chargeback',
      economicReversalOfProviderRef: originalRef,
    });
  });

  it('does not queue a full containment refund when another partial adjustment remains successful', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    const apply = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded' | 'reversed'; providerRef: string; amountMinor: number; currency: string },
          reason: 'refund' | 'chargeback',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);
    const chargebackRef = `stub_partial_containment_chargeback_${out.paymentId}`;
    await apply(
      await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
      { state: 'succeeded', providerRef: chargebackRef, amountMinor: 720_000, currency: out.currency },
      'chargeback',
    );
    await apply(
      await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
      { state: 'succeeded', providerRef: `stub_partial_containment_refund_${out.paymentId}`, amountMinor: 480_000, currency: out.currency },
      'refund',
    );
    expect(await ledger.balance(walletId)).toBe(0);

    expect(
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        { state: 'reversed', providerRef: chargebackRef, amountMinor: 720_000, currency: out.currency },
        'chargeback',
      ),
    ).toBe('refund_reversed');
    expect(await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).toMatchObject({
      status: 'NEEDS_REVIEW',
      failureReason: expect.stringContaining('partial return'),
    });
    expect(await db.refundRequest.findUnique({ where: { paymentId: out.paymentId } })).toBeNull();
    expect(await ledger.balance(walletId)).toBe(360);
  });

  it('atomically reserves credits restored by an automatic reversal and releases only that cycle on provider failure', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    const apply = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded' | 'reversed'; providerRef: string; amountMinor: number; currency: string },
          reason: 'refund',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);
    const adjustmentRef = `stub_subscription_reversal_${out.paymentId}`;
    expect(
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        { state: 'succeeded', providerRef: adjustmentRef, amountMinor: out.amountMinor, currency: out.currency },
        'refund',
      ),
    ).toBe('refunded');
    expect(await ledger.balance(walletId)).toBe(0);

    expect(
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        { state: 'reversed', providerRef: adjustmentRef, amountMinor: out.amountMinor, currency: out.currency },
        'refund',
      ),
    ).toBe('refund_reversed');
    const replacement = await db.refundRequest.findUniqueOrThrow({ where: { paymentId: out.paymentId } });
    expect(replacement).toMatchObject({ status: 'PROCESSING', requestedById: null, refundCycle: 1, processingAt: null, gatewayRef: null });
    expect(await ledger.balance(walletId)).toBe(0);
    expect(
      await db.ledgerEntry.findUnique({
        where: {
          walletId_idempotencyKey: {
            walletId,
            idempotencyKey: `refund-request:${replacement.id}:cycle:${replacement.refundCycle}:reserve:clawback`,
          },
        },
        select: { delta: true },
      }),
    ).toEqual({ delta: -out.credits });

    const replacementRef = `stub_replacement_failed_${out.paymentId}`;
    const failed = await (
      service as unknown as {
        applyRefundVerification(
          payment: Payment,
          verification: { state: 'failed'; providerRef: string; amountMinor: number; currency: string; reason: string },
          reason: 'refund',
          cycle: { requestId: string; refundCycle: number },
        ): Promise<string>;
      }
    ).applyRefundVerification(
      await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
      {
        state: 'failed',
        providerRef: replacementRef,
        amountMinor: out.amountMinor,
        currency: out.currency,
        reason: 'replacement refund rejected',
      },
      'refund',
      { requestId: replacement.id, refundCycle: replacement.refundCycle },
    );
    expect(failed).toBe('refund_failed');
    expect(await db.refundRequest.findUniqueOrThrow({ where: { id: replacement.id } })).toMatchObject({ status: 'NEEDS_REVIEW' });
    expect(await ledger.balance(walletId)).toBe(out.credits);
  });

  it('reserves all funded credits when earlier partial reversals preceded the automatic replacement refund', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'month' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    const apply = (
      service as unknown as {
        applyConfirmedAdjustment(
          payment: Payment,
          verification: { state: 'succeeded' | 'reversed'; providerRef: string; amountMinor: number; currency: string },
          reason: 'refund',
        ): Promise<string>;
      }
    ).applyConfirmedAdjustment.bind(service);
    const firstRef = `stub_staged_reversal_first_${out.paymentId}`;
    const secondRef = `stub_staged_reversal_second_${out.paymentId}`;
    for (const [providerRef, amountMinor] of [
      [firstRef, 720_000],
      [secondRef, 480_000],
    ] as const) {
      await apply(
        await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
        { state: 'succeeded', providerRef, amountMinor, currency: out.currency },
        'refund',
      );
    }
    expect(await ledger.balance(walletId)).toBe(0);

    await apply(
      await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
      { state: 'reversed', providerRef: firstRef, amountMinor: 720_000, currency: out.currency },
      'refund',
    );
    expect(await ledger.balance(walletId)).toBe(360);
    expect(await db.refundRequest.findUnique({ where: { paymentId: out.paymentId } })).toBeNull();

    await apply(
      await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } }),
      { state: 'reversed', providerRef: secondRef, amountMinor: 480_000, currency: out.currency },
      'refund',
    );
    const replacement = await db.refundRequest.findUniqueOrThrow({ where: { paymentId: out.paymentId } });
    expect(
      await db.ledgerEntry.findUnique({
        where: {
          walletId_idempotencyKey: {
            walletId,
            idempotencyKey: `refund-request:${replacement.id}:cycle:${replacement.refundCycle}:reserve:clawback`,
          },
        },
        select: { delta: true },
      }),
    ).toEqual({ delta: -out.credits });
    expect(await ledger.balance(walletId)).toBe(0);
  });

  it('only the owner, an admin or the billing contact can buy', async () => {
    await expect(service.checkout(actor('MEMBER'), workspaceId, { kind: 'pack', code: 'test.pack' }, req)).rejects.toMatchObject({ status: 403 });
    await expect(service.checkout(actor('BILLING'), workspaceId, { kind: 'pack', code: 'test.pack' }, req)).resolves.toMatchObject({ credits: 200 });
  });
});
