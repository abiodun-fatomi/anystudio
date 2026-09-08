import { createHmac } from 'node:crypto';
import type { Payment, PaymentKind } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaddleGateway } from './paddle.gateway';

const secret = 'pdl_ntfset_gateway_test';
const gateway = new PaddleGateway('pdl_sdbx_apikey_test', secret, 'sandbox');

type Call = { url: string; init: RequestInit };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function script(responses: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const call = { url: String(url), init };
      calls.push(call);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected call to ${call.url}`);
      return next(call);
    }),
  );
  return calls;
}

function payment(kind: PaymentKind): Payment {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    workspaceId: '20000000-0000-4000-8000-000000000001',
    userId: '30000000-0000-4000-8000-000000000001',
    provider: 'PADDLE',
    kind,
    status: 'PENDING',
    reference: 'as_plan_initial',
    providerRef: 'txn_01h46c8hm8dxa3k4f6w8q9t0ab',
    itemCode: kind === 'PACK' ? 'pack.small' : 'creator',
    interval: kind === 'SUBSCRIPTION' || kind === 'RENEWAL' ? 'month' : null,
    credits: 600,
    amountMinor: 900,
    currency: 'USD',
    checkoutUrl: null,
    providerPayload: { catalogueRef: 'pri_01h46c8hm8dxa3k4f6w8q9t0ab' },
    ledgerEntryId: null,
    subscriptionId: null,
    failureReason: null,
    refundedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
}

function paidTransaction(subscriptionId?: string) {
  return {
    id: 'txn_01h46c8hm8dxa3k4f6w8q9t0ab',
    status: 'paid',
    customer_id: 'ctm_01h46cbcch8as5prh0tpc7m3gg',
    subscription_id: subscriptionId ?? null,
    currency_code: 'USD',
    origin: 'api',
    custom_data: { paymentId: '10000000-0000-4000-8000-000000000001', reference: 'as_plan_initial' },
    items: [{ price: { id: 'pri_01h46c8hm8dxa3k4f6w8q9t0ab' }, quantity: 1 }],
    details: { totals: { grand_total: '900', currency_code: 'USD' } },
  };
}

afterEach(() => vi.unstubAllGlobals());

function signed(payload: Record<string, unknown>, now = Date.now()) {
  const raw = Buffer.from(JSON.stringify(payload));
  const ts = Math.floor(now / 1000);
  const h1 = createHmac('sha256', secret).update(`${ts}:`).update(raw).digest('hex');
  return {
    raw,
    parsed: gateway.parseWebhook(raw, { 'paddle-signature': `ts=${ts};h1=${h1}` }),
  };
}

function transactionData(origin: string, id: string) {
  return {
    id,
    status: 'completed',
    customer_id: 'ctm_01h46cbcch8as5prh0tpc7m3gg',
    subscription_id: 'sub_01h977gba44w4mb1p4scgxtzwh',
    currency_code: 'USD',
    origin,
    custom_data: {
      paymentId: 'pay_initial',
      reference: 'as_plan_initial',
      workspaceId: 'ws_123',
      itemCode: 'creator',
    },
    billing_period: {
      starts_at: '2026-09-01T00:00:00Z',
      ends_at: '2026-10-01T00:00:00Z',
    },
  };
}

describe('PaddleGateway webhooks', () => {
  it.each(['credit', 'credit_reverse'])('routes %s to verified adjustment review instead of ignoring it', async (action) => {
    const data = {
      id: `adj_${action}`,
      action,
      status: 'approved',
      transaction_id: payment('INVOICE').providerRef,
      totals: { total: '900', currency_code: 'USD' },
    };
    const { parsed } = signed({ event_id: `evt_${action}`, event_type: 'adjustment.updated', data });
    expect(gateway.interpret(parsed)).toMatchObject({ kind: 'refund', refundRef: data.id });
    script([() => json({ data })]);
    expect(await gateway.verifyRefund(payment('INVOICE'), data.id)).toMatchObject({
      providerRef: data.id,
      providerAction: action,
      amountMinor: 900,
      currency: 'USD',
    });
  });

  it.each(['api', 'web'])('keeps the checkout reference for an initial %s transaction', (origin) => {
    const { parsed } = signed({
      event_id: 'evt_01h46c9jz8dxa3k4f6w8q9t0ab',
      event_type: 'transaction.completed',
      occurred_at: '2026-09-01T00:00:03Z',
      notification_id: 'ntf_01h46c9m0c1v2b3n4m5k6j7h8g',
      data: transactionData(origin, 'txn_01h46c8hm8dxa3k4f6w8q9t0ab'),
    });

    expect(parsed.signatureOk).toBe(true);
    expect(parsed.eventId).toBe('evt_01h46c9jz8dxa3k4f6w8q9t0ab');
    expect(gateway.interpret(parsed)).toMatchObject({
      kind: 'charge',
      reference: 'as_plan_initial',
      providerRef: 'txn_01h46c8hm8dxa3k4f6w8q9t0ab',
      subscriptionRef: 'sub_01h977gba44w4mb1p4scgxtzwh',
      status: 'succeeded',
    });
  });

  it.each(['transaction.paid', 'transaction.completed'])('%s ignores the inherited checkout reference for a recurring transaction', (eventType) => {
    const transactionId = 'txn_01h977bq0v6rqw5p9nt0q6jv5t';
    const { parsed } = signed({
      event_id: `evt_${eventType === 'transaction.paid' ? 'paid' : 'completed'}_renewal`,
      event_type: eventType,
      occurred_at: '2026-10-01T00:00:03Z',
      notification_id: `ntf_${eventType === 'transaction.paid' ? 'paid' : 'completed'}_renewal`,
      data: transactionData('subscription_recurring', transactionId),
    });
    const intent = gateway.interpret(parsed);

    expect(intent).toMatchObject({
      kind: 'charge',
      providerRef: transactionId,
      subscriptionRef: 'sub_01h977gba44w4mb1p4scgxtzwh',
      status: 'succeeded',
    });
    expect(intent.kind).toBe('charge');
    if (intent.kind === 'charge') expect(intent.reference).toBeUndefined();
  });

  it.each(['transaction.payment_failed', 'transaction.past_due'])('%s does not attach the initial checkout reference to a failed renewal', (eventType) => {
    const data = { ...transactionData('subscription_recurring', 'txn_renewal_failed'), status: 'past_due' };
    const { parsed } = signed({
      event_id: 'evt_renewal_failed',
      event_type: eventType,
      occurred_at: '2026-10-01T00:00:03Z',
      notification_id: 'ntf_renewal_failed',
      data,
    });
    const intent = gateway.interpret(parsed);

    expect(intent).toMatchObject({ kind: 'charge', providerRef: 'txn_renewal_failed', status: 'failed' });
    expect(intent.kind).toBe('charge');
    if (intent.kind === 'charge') expect(intent.reference).toBeUndefined();
  });

  it('verifies the exact raw body and derives a stable, event-type-scoped fallback id', () => {
    const payload = {
      event_type: 'transaction.completed',
      data: transactionData('subscription_recurring', 'txn_stable_renewal'),
    };
    const { raw, parsed } = signed(payload);

    expect(parsed.signatureOk).toBe(true);
    expect(parsed.eventId).toBe('transaction.completed:txn_stable_renewal');
    expect(gateway.parseWebhook(Buffer.from(`${raw.toString()} `), { 'paddle-signature': 'ts=0;h1=invalid' }).signatureOk).toBe(false);

    const paid = signed({ ...payload, event_type: 'transaction.paid' }).parsed;
    expect(paid.eventId).toBe('transaction.paid:txn_stable_renewal');
  });

  it.each([
    ['refund pending approval', 'refund', 'pending_approval', 'pending'],
    ['refund approved', 'refund', 'approved', 'succeeded'],
    ['chargeback confirmed', 'chargeback', 'approved', 'succeeded'],
    ['chargeback reversed', 'chargeback_reverse', 'approved', 'reversed'],
  ])('maps %s without treating a submission as completed', (_label, action, status, expected) => {
    const transactionId = 'txn_01h977bq0v6rqw5p9nt0q6jv5t';
    const { parsed } = signed({
      event_id: `evt_adjustment_${action}_${status}`,
      event_type: 'adjustment.updated',
      occurred_at: '2026-10-01T00:00:03Z',
      data: {
        id: 'adj_01hvgf2s84dr6reszzg29zbvcm',
        action,
        status,
        transaction_id: transactionId,
        totals: { total: '900', currency_code: 'USD' },
      },
    });

    expect(gateway.interpret(parsed)).toMatchObject({
      kind: 'refund',
      providerRef: transactionId,
      refundRef: 'adj_01hvgf2s84dr6reszzg29zbvcm',
      status: expected,
      amountMinor: 900,
      currency: 'USD',
    });
  });

  it.each([
    ['chargeback_warning', 'succeeded'],
    ['chargeback_warning_reverse', 'reversed'],
  ])('maps financial %s adjustments', (action, status) => {
    const { parsed } = signed({
      event_id: `evt_${action}`,
      event_type: 'adjustment.updated',
      data: {
        id: `adj_${action}`,
        action,
        status: 'approved',
        transaction_id: 'txn_warning',
        totals: { total: '900', currency_code: 'USD' },
      },
    });

    expect(gateway.interpret(parsed)).toMatchObject({
      kind: 'refund',
      providerRef: 'txn_warning',
      refundRef: `adj_${action}`,
      status,
      amountMinor: 900,
      currency: 'USD',
      reason: 'chargeback',
    });
  });

  it('treats subscription.canceled as terminal even when its period timestamp is in the future', () => {
    const { parsed } = signed({
      event_id: 'evt_subscription_terminal_cancel',
      event_type: 'subscription.canceled',
      occurred_at: '2026-09-01T00:00:03Z',
      data: {
        id: 'sub_01h977gba44w4mb1p4scgxtzwh',
        customer_id: 'ctm_01h46cbcch8as5prh0tpc7m3gg',
        status: 'canceled',
        current_billing_period: { starts_at: '2026-09-01T00:00:00Z', ends_at: '2027-09-01T00:00:00Z' },
      },
    });

    expect(gateway.interpret(parsed)).toMatchObject({
      kind: 'subscription',
      subscriptionRef: 'sub_01h977gba44w4mb1p4scgxtzwh',
      status: 'cancelled',
      cancelAtPeriodEnd: false,
    });
  });
});

describe('PaddleGateway verification and refunds', () => {
  it.each([
    ['chargeback_warning', 'succeeded'],
    ['chargeback_warning_reverse', 'reversed'],
  ])('treats fetched financial %s as %s', async (action, state) => {
    script([
      () =>
        json({
          data: {
            id: `adj_${action}`,
            action,
            status: 'approved',
            transaction_id: 'txn_01h46c8hm8dxa3k4f6w8q9t0ab',
            totals: { total: '900', currency_code: 'USD' },
          },
        }),
    ]);

    await expect(gateway.verifyRefund(payment('PACK'), `adj_${action}`)).resolves.toMatchObject({
      state,
      amountMinor: 900,
      currency: 'USD',
      providerAction: action,
      reversalMode: 'separate_adjustment',
    });
  });

  it('carries the payment id through the hosted Paddle page', async () => {
    const calls = script([() => json({ data: { id: 'txn_checkout_123' } })]);
    const row = payment('PACK');

    await expect(
      gateway.createCheckout({
        payment: row,
        item: {
          kind: 'pack',
          code: 'pack.small',
          credits: 600,
          amountMinor: 900,
          currency: 'USD',
          providerRef: 'pri_01h46c8hm8dxa3k4f6w8q9t0ab',
          label: 'Small pack',
        },
        customer: { email: 'member@example.com', name: 'Member', phone: null },
        returnUrl: `https://app.test/billing/return?ref=${row.reference}&paymentId=${row.id}`,
        appOrigin: 'https://app.test',
      }),
    ).resolves.toEqual({
      providerRef: 'txn_checkout_123',
      url: `https://app.test/billing/pay?_ptxn=txn_checkout_123&ref=${row.reference}&paymentId=${row.id}`,
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ custom_data: { paymentId: row.id, reference: row.reference } });
  });

  it('keeps a paid plan pending until Paddle attaches its subscription', async () => {
    script([() => json({ data: paidTransaction() })]);

    await expect(gateway.verify(payment('SUBSCRIPTION'))).resolves.toMatchObject({
      ok: false,
      state: 'pending',
      reason: 'paid transaction is awaiting subscription creation',
    });
  });

  it('settles a paid plan once the transaction carries subscription evidence', async () => {
    script([() => json({ data: paidTransaction('sub_01h977gba44w4mb1p4scgxtzwh') })]);

    await expect(gateway.verify(payment('SUBSCRIPTION'))).resolves.toMatchObject({
      ok: true,
      subscriptionRef: 'sub_01h977gba44w4mb1p4scgxtzwh',
    });
  });

  it('settles a completed plan because Paddle has finished internal processing', async () => {
    script([() => json({ data: { ...paidTransaction(), status: 'completed' } })]);

    await expect(gateway.verify(payment('SUBSCRIPTION'))).resolves.toMatchObject({
      ok: true,
      providerRef: 'txn_01h46c8hm8dxa3k4f6w8q9t0ab',
    });
  });

  it('allows a paid one-time pack to settle without a subscription id', async () => {
    script([() => json({ data: paidTransaction() })]);

    await expect(gateway.verify(payment('PACK'))).resolves.toMatchObject({ ok: true, providerRef: 'txn_01h46c8hm8dxa3k4f6w8q9t0ab' });
  });

  it('settles an invoice only when its inline subtotal, discount, and currency match', async () => {
    const row = { ...payment('INVOICE'), providerPayload: {} };
    script([
      () =>
        json({
          data: {
            ...paidTransaction(),
            items: [{ quantity: 1 }],
            details: { totals: { subtotal: '900', discount: '0', total: '1050', grand_total: '1050', currency_code: 'USD' } },
          },
        }),
    ]);

    await expect(gateway.verify(row)).resolves.toMatchObject({ ok: true, amountMinor: 1050, currency: 'USD' });
  });

  it.each([
    [{ subtotal: '800', discount: '0', total: '950', grand_total: '950', currency_code: 'USD' }, 'lower subtotal'],
    [{ subtotal: '900', discount: '100', total: '950', grand_total: '950', currency_code: 'USD' }, 'discount'],
    [{ subtotal: '900', discount: '0', total: '1050', grand_total: '1050', currency_code: 'EUR' }, 'currency mismatch'],
  ])('rejects an invoice with a %s', async (totals) => {
    const row = { ...payment('INVOICE'), providerPayload: {} };
    script([() => json({ data: { ...paidTransaction(), items: [{ quantity: 1 }], details: { totals } } })]);

    await expect(gateway.verify(row)).resolves.toMatchObject({ ok: false, state: 'failed', reason: expect.stringContaining('invoice amount mismatch') });
  });

  it('turns a definitive adjustment validation rejection into a failed verification', async () => {
    script([
      () => json({ data: { ...paidTransaction(), status: 'completed', details: { line_items: [{ id: 'txnitm_01h46c8hm8dxa3k4f6w8q9t0ab' }] } } }),
      () => json({ error: { code: 'transaction_not_refundable' } }, 422),
    ]);

    await expect(gateway.refund(payment('PACK'), 'requested by customer')).resolves.toMatchObject({
      state: 'failed',
      amountMinor: 900,
      currency: 'USD',
    });
  });

  it('reconciles provider truth after a duplicate-adjustment conflict', async () => {
    const calls = script([
      () => json({ data: { ...paidTransaction(), status: 'completed', details: { line_items: [{ id: 'txnitm_01h46c8hm8dxa3k4f6w8q9t0ab' }] } } }),
      () => json({ error: { code: 'conflict' } }, 409),
      () =>
        json({
          data: [
            {
              id: 'adj_01hvgf2s84dr6reszzg29zbvcm',
              action: 'refund',
              status: 'approved',
              transaction_id: 'txn_01h46c8hm8dxa3k4f6w8q9t0ab',
              totals: { total: '900', currency_code: 'USD' },
            },
          ],
        }),
    ]);

    await expect(gateway.refund(payment('PACK'), 'requested by customer')).resolves.toMatchObject({
      state: 'succeeded',
      providerRef: 'adj_01hvgf2s84dr6reszzg29zbvcm',
    });
    expect(calls[2]?.url).toContain('/adjustments?transaction_id=txn_01h46c8hm8dxa3k4f6w8q9t0ab');
  });
});
