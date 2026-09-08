import { createHmac } from 'node:crypto';
import type { Payment, PaymentKind } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlutterwaveGateway } from './flutterwave.gateway';

const webhookSecret = 'flutterwave-dashboard-secret';
const gateway = new FlutterwaveGateway('FLWSECK_TEST-key', webhookSecret);

function webhook(payload: Record<string, unknown>, headers: Record<string, string> = { 'verif-hash': webhookSecret }) {
  const raw = Buffer.from(JSON.stringify(payload));
  return { raw, parsed: gateway.parseWebhook(raw, headers) };
}

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

function payment(kind: PaymentKind = 'SUBSCRIPTION'): Payment {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    workspaceId: '20000000-0000-4000-8000-000000000001',
    userId: '30000000-0000-4000-8000-000000000001',
    provider: 'FLUTTERWAVE',
    kind,
    status: 'PENDING',
    reference: 'as_plan_initial',
    providerRef: null,
    itemCode: 'creator',
    interval: kind === 'PACK' || kind === 'INVOICE' ? null : 'month',
    credits: 600,
    amountMinor: 1_200_000,
    currency: 'NGN',
    checkoutUrl: null,
    providerPayload: { catalogueRef: '10944' },
    ledgerEntryId: null,
    subscriptionId: null,
    failureReason: null,
    refundedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('FlutterwaveGateway verification and refunds', () => {
  it('verifies a recurring payment through its subscription when the transaction omits the plan', async () => {
    const calls = script([
      () =>
        json({
          status: 'success',
          data: {
            id: 285959875,
            tx_ref: 'as_plan_initial',
            amount: 12_000,
            currency: 'NGN',
            status: 'successful',
            customer: { email: 'Member@Example.com' },
          },
        }),
      () =>
        json({
          status: 'success',
          data: [{ id: 7711, plan: { id: 10944 }, status: 'active', customer: { customer_email: 'member@example.com' } }],
        }),
    ]);

    const result = await gateway.verify(payment(), { providerRef: '285959875' });

    expect(result).toMatchObject({ ok: true, providerRef: '285959875', subscriptionRef: '7711', customerRef: 'member@example.com' });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.flutterwave.com/v3/transactions/285959875/verify',
      'https://api.flutterwave.com/v3/subscriptions?transaction_id=285959875',
    ]);
  });

  it('rejects a recurring payment whose resolved subscription belongs to another plan', async () => {
    script([
      () =>
        json({
          status: 'success',
          data: { id: 285959875, tx_ref: 'as_plan_initial', amount: 12_000, currency: 'NGN', status: 'successful' },
        }),
      () => json({ status: 'success', data: [{ id: 7711, plan: 99999, status: 'active', customer: { email: 'member@example.com' } }] }),
    ]);

    await expect(gateway.verify(payment(), { providerRef: '285959875' })).resolves.toMatchObject({
      ok: false,
      state: 'failed',
      reason: 'payment plan mismatch: 99999',
    });
  });

  it('verifies a renewal against the resolved subscription identity instead of an inherited transaction reference', async () => {
    const row = {
      ...payment('RENEWAL'),
      reference: 'as_renewal_local',
      providerPayload: {
        catalogueRef: '10944',
        subscriptionRef: '7711',
        customerRef: 'member@example.com',
      },
    };
    script([
      () =>
        json({
          status: 'success',
          data: {
            id: 285959876,
            // Flutterwave recurring charges may retain the first checkout ref.
            tx_ref: 'as_plan_initial',
            amount: 12_000,
            currency: 'NGN',
            status: 'successful',
            customer: { email: 'Member@Example.com' },
          },
        }),
      () =>
        json({
          status: 'success',
          data: [{ id: 7711, plan: { id: 10944 }, status: 'active', customer: { customer_email: 'member@example.com' } }],
        }),
    ]);

    await expect(gateway.verify(row, { providerRef: '285959876' })).resolves.toMatchObject({
      ok: true,
      providerRef: '285959876',
      subscriptionRef: '7711',
      customerRef: 'member@example.com',
    });
  });

  it('turns a definitive refund validation rejection into a failed verification', async () => {
    script([() => json({ status: 'error', message: 'Amount should be above NGN100' }, 400)]);

    await expect(gateway.refund({ ...payment('PACK'), providerRef: '285959875' }, 'requested by customer')).resolves.toMatchObject({
      state: 'failed',
      amountMinor: 1_200_000,
      currency: 'NGN',
    });
  });

  it('reconciles provider truth after a duplicate-refund conflict', async () => {
    const calls = script([
      () => json({ status: 'error', message: 'already refunded' }, 409),
      () =>
        json({
          status: 'success',
          data: [{ id: 88001, TransactionId: 285959875, AmountRefunded: 12_000, currency: 'NGN', status: 'completed-mpgs' }],
        }),
    ]);

    await expect(gateway.refund({ ...payment('PACK'), providerRef: '285959875' }, 'requested by customer')).resolves.toMatchObject({
      state: 'succeeded',
      providerRef: '88001',
    });
    expect(calls[1]?.url).toContain('/refunds?');
    expect(calls[1]?.url).toContain('id=285959875');
  });
});

describe('FlutterwaveGateway webhooks', () => {
  it('keeps v3 and v4 signature verification behavior', () => {
    const payload = {
      event: 'charge.completed',
      data: { id: 285959875, tx_ref: 'as_plan_initial', status: 'successful' },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const hex = createHmac('sha256', webhookSecret).update(raw).digest('hex');
    const base64 = createHmac('sha256', webhookSecret).update(raw).digest('base64');

    expect(gateway.parseWebhook(raw, { 'verif-hash': webhookSecret }).signatureOk).toBe(true);
    expect(gateway.parseWebhook(raw, { 'flutterwave-signature': hex }).signatureOk).toBe(true);
    expect(gateway.parseWebhook(raw, { 'flutterwave-signature': base64 }).signatureOk).toBe(true);
    expect(gateway.parseWebhook(raw, { 'verif-hash': 'wrong-secret' }).signatureOk).toBe(false);
    expect(gateway.parseWebhook(Buffer.from(`${raw.toString()} `), { 'flutterwave-signature': hex }).signatureOk).toBe(false);
  });

  it('parses a v3 recurring charge with the documented plan object and customer email', () => {
    const { parsed } = webhook({
      event: 'charge.completed',
      data: {
        id: 285959875,
        tx_ref: 'as_renew_flw_01',
        amount: 12_000,
        currency: 'NGN',
        status: 'successful',
        customer: { email: '  Member@Example.COM  ' },
        plan: { id: 10944, name: 'Creator Monthly', interval: 'monthly' },
      },
    });
    const intent = gateway.interpret(parsed);

    expect(parsed.eventId).toBe('charge.completed:285959875');
    expect(intent).toEqual({
      kind: 'charge',
      reference: 'as_renew_flw_01',
      providerRef: '285959875',
      customerRef: 'member@example.com',
      planRef: '10944',
      customerEmail: 'member@example.com',
      status: 'succeeded',
    });
    expect(intent.kind).toBe('charge');
    if (intent.kind === 'charge') expect(intent.subscriptionRef).toBeUndefined();
  });

  it.each([
    ['plan scalar', { plan: 10944 }],
    ['payment_plan scalar', { payment_plan: '10944' }],
    ['payment_plan object', { payment_plan: { id: '10944' } }],
  ])('normalizes %s on recurring charges', (_label, planFields) => {
    const { parsed } = webhook({
      event: 'charge.completed',
      data: {
        id: 285959876,
        tx_ref: 'as_renew_flw_02',
        status: 'successful',
        customer: { email: 'member@example.com' },
        ...planFields,
      },
    });

    expect(gateway.interpret(parsed)).toMatchObject({
      kind: 'charge',
      planRef: '10944',
      customerEmail: 'member@example.com',
    });
  });

  it('uses the current v4 envelope id and transaction reference fields', () => {
    const { parsed } = webhook({
      id: 'wbk_01k4c6g3s7h8j9k0m1n2p3q4r5',
      type: 'charge.completed',
      timestamp: 1_788_736_400,
      data: {
        id: 'chg_01k4c6d9m8n7p6q5r4s3t2u1v0',
        reference: 'as_plan_v4',
        status: 'succeeded',
        customer: { email: 'V4@Example.com' },
        payment_plan: 10944,
      },
    });

    expect(parsed.eventId).toBe('wbk_01k4c6g3s7h8j9k0m1n2p3q4r5');
    expect(gateway.interpret(parsed)).toMatchObject({
      kind: 'charge',
      reference: 'as_plan_v4',
      providerRef: 'chg_01k4c6d9m8n7p6q5r4s3t2u1v0',
      planRef: '10944',
      customerEmail: 'v4@example.com',
      status: 'succeeded',
    });
  });

  it('uses tx_ref as the stable v3 event fallback when the transaction id is absent', () => {
    const payload = {
      event: 'charge.completed',
      data: { tx_ref: 'as_renew_stable', status: 'successful', customer: { email: 'member@example.com' }, payment_plan: 10944 },
    };
    const first = webhook(payload).parsed;
    const second = webhook(payload).parsed;

    expect(first.eventId).toBe('charge.completed:as_renew_stable');
    expect(second.eventId).toBe(first.eventId);
    expect(gateway.interpret(first)).toMatchObject({ kind: 'charge', reference: 'as_renew_stable' });
  });

  it('parses the documented subscription cancellation plan object', () => {
    const payload = {
      event: 'subscription.cancelled',
      data: {
        status: 'deactivated',
        currency: 'NGN',
        amount: 200,
        customer: { email: 'Cancelled@Example.COM', full_name: 'Example customer' },
        plan: {
          id: 10944,
          name: 'Creator Monthly',
          amount: 200,
          currency: 'NGN',
          interval: 'monthly',
          duration: 1,
          status: 'cancel',
        },
      },
    };
    const first = webhook(payload).parsed;
    const second = webhook(payload).parsed;

    expect(first.eventId).toBe(second.eventId);
    expect(first.eventId).toMatch(/^subscription\.cancelled:[a-f0-9]{64}$/);
    expect(gateway.interpret(first)).toEqual({
      kind: 'subscription',
      catalogueRef: '10944',
      customerRef: 'cancelled@example.com',
      reference: undefined,
      status: 'cancelled',
    });
  });

  it.each([
    ['plan scalar', { plan: '10944' }],
    ['payment_plan scalar', { payment_plan: 10944 }],
    ['payment_plan object', { payment_plan: { id: 10944 } }],
  ])('normalizes %s on subscription cancellations', (_label, planFields) => {
    const { parsed } = webhook({
      event: 'subscription.cancelled',
      data: { customer: { customer_email: 'Member@Example.com' }, ...planFields },
    });

    expect(gateway.interpret(parsed)).toEqual({
      kind: 'subscription',
      catalogueRef: '10944',
      customerRef: 'member@example.com',
      reference: undefined,
      status: 'cancelled',
    });
  });

  it('ignores an unidentifiable subscription cancellation instead of emitting an empty reference', () => {
    const { parsed } = webhook({ event: 'subscription.cancelled', data: { customer: { email: 'member@example.com' } } });

    expect(gateway.interpret(parsed)).toEqual({ kind: 'ignore', why: 'subscription cancellation without a plan or subscription id' });
  });

  it('normalizes the documented uppercase refund transaction and amount fields', () => {
    const { parsed } = webhook({
      event: 'refund.completed',
      data: { id: 88001, TransactionId: 285959875, AmountRefunded: 12_000, currency: 'NGN', status: 'completed-bank-transfer' },
    });

    expect(gateway.interpret(parsed)).toEqual({
      kind: 'refund',
      providerRef: '285959875',
      refundRef: '88001',
      status: 'succeeded',
      amountMinor: 1_200_000,
      currency: 'NGN',
      reason: 'refund',
    });
  });

  it("normalizes Flutterwave's official flat refund webhook for provider re-fetch", () => {
    const { parsed } = webhook({
      id: 89074,
      AmountRefunded: 5000,
      status: 'completed',
      FlwRef: 'flwm3s4m0c1754324273641',
      TransactionId: 8784082,
    });

    expect(parsed).toMatchObject({ signatureOk: true, type: 'refund.completed', eventId: 'refund.completed:89074' });
    expect(gateway.interpret(parsed)).toEqual({
      kind: 'refund',
      providerRef: '8784082',
      refundRef: '89074',
      status: 'pending',
      amountMinor: 500_000,
      currency: undefined,
      reason: 'refund',
    });
  });

  it('retains an official chargeback webhook for provider-side transaction resolution', () => {
    const { parsed } = webhook({
      event: 'chargeback.initiated',
      data: { id: 22221, flw_ref: '0550726510071683619721660', amount: 500, status: 'initiated', stage: 'new' },
    });

    expect(gateway.interpret(parsed)).toEqual({
      kind: 'refund',
      providerRef: undefined,
      refundRef: 'chargeback:0550726510071683619721660',
      status: 'succeeded',
      amountMinor: undefined,
      currency: undefined,
      reason: 'chargeback',
    });
  });
});
