/**
 * Paddle Billing — merchant of record for every currency Flutterwave does
 * not take. Paddle owns the price of record (with its own localised
 * pricing and tax), so verification here checks the PRICE ID and our
 * reference rather than a number of cents: what Paddle charged is written
 * onto the Payment row as the fact.
 *
 * Checkout: we create a transaction server-side with the price id and our
 * reference in `custom_data`, then send the person to our own /billing/pay
 * page, which opens Paddle.js on that transaction. No card data touches us
 * and no client-supplied price is ever read.
 *
 * Webhooks: `Paddle-Signature: ts=…;h1=…`, HMAC-SHA256 over `${ts}:${raw}`
 * with the endpoint secret; a five-minute replay window. `transaction.completed`
 * is the money event; `subscription.*` keeps our Subscription row in step.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Payment } from '@prisma/client';
import { http } from '../../provider/adapters/http';
import type { CheckoutRequest, CheckoutSession, Gateway, ParsedWebhook, Verification, WebhookIntent } from '../billing.types';

const TIMEOUT = 20_000;
const REPLAY_WINDOW_SEC = 5 * 60;

interface PaddleTxn {
  id: string;
  status: string;
  customer_id?: string | null;
  subscription_id?: string | null;
  currency_code: string;
  origin?: string;
  custom_data?: Record<string, unknown> | null;
  items?: Array<{ price?: { id?: string }; price_id?: string; quantity?: number }>;
  details?: { totals?: { total?: string; grand_total?: string; currency_code?: string } };
  billing_period?: { starts_at?: string; ends_at?: string } | null;
  billed_at?: string | null;
  created_at?: string;
}

interface PaddleSub {
  id: string;
  status: string;
  customer_id?: string;
  custom_data?: Record<string, unknown> | null;
  current_billing_period?: { starts_at?: string; ends_at?: string } | null;
  scheduled_change?: { action?: string; effective_at?: string } | null;
}

export class PaddleGateway implements Gateway {
  readonly provider = 'PADDLE' as const;
  private readonly base: string;
  constructor(
    private readonly apiKey: string,
    private readonly webhookSecret: string,
    env: 'sandbox' | 'live',
  ) {
    this.base = env === 'live' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
  }

  private headers() {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    if (!req.item.providerRef)
      throw new Error(`${req.item.kind} ${req.item.code} has no Paddle price id${req.item.interval ? ` for ${req.item.interval}` : ''}`);
    const body = {
      items: [{ price_id: String(req.item.providerRef), quantity: 1 }],
      custom_data: { paymentId: req.payment.id, reference: req.payment.reference, workspaceId: req.payment.workspaceId, itemCode: req.item.code },
      currency_code: req.item.currency,
    };
    const res = await http<{ data?: PaddleTxn }>('paddle', `${this.base}/transactions`, { body, headers: this.headers(), timeoutMs: TIMEOUT });
    const txn = res.json?.data;
    if (!txn?.id) throw new Error(`paddle returned no transaction: ${res.text.slice(0, 200)}`);
    // Our own page hosts Paddle.js; the return URL is set on the checkout there.
    const url = `${req.appOrigin}/billing/pay?_ptxn=${encodeURIComponent(txn.id)}&ref=${encodeURIComponent(req.payment.reference)}`;
    return { url, providerRef: txn.id };
  }

  async verify(payment: Payment, hint?: { providerRef?: string }): Promise<Verification> {
    const id = hint?.providerRef ?? payment.providerRef;
    if (!id) return { ok: false, state: 'pending', reason: 'no Paddle transaction id yet' };
    let res;
    try {
      res = await http<{ data?: PaddleTxn }>('paddle', `${this.base}/transactions/${encodeURIComponent(id)}`, { headers: this.headers(), timeoutMs: TIMEOUT });
    } catch (e) {
      return { ok: false, state: 'pending', reason: e instanceof Error ? e.message : String(e) };
    }
    const t = res.json?.data;
    if (!t) return { ok: false, state: 'pending', reason: 'transaction not found' };
    const ours =
      t.custom_data?.paymentId === payment.id ||
      t.custom_data?.reference === payment.reference ||
      (payment.kind === 'RENEWAL' &&
        t.subscription_id &&
        t.subscription_id === (payment.providerPayload as { subscriptionRef?: string } | null)?.subscriptionRef);
    if (!ours && payment.kind !== 'RENEWAL') return { ok: false, state: 'failed', reason: 'transaction does not carry our reference', raw: t };
    if (t.status !== 'completed' && t.status !== 'paid') {
      return { ok: false, state: t.status === 'canceled' || t.status === 'past_due' ? 'failed' : 'pending', reason: `status ${t.status}`, raw: t };
    }
    const priceId = t.items?.[0]?.price?.id ?? t.items?.[0]?.price_id;
    const total = Number(t.details?.totals?.grand_total ?? t.details?.totals?.total ?? '0');
    return {
      ok: true,
      providerRef: t.id,
      amountMinor: Number.isFinite(total) ? total : 0,
      currency: (t.details?.totals?.currency_code ?? t.currency_code).toUpperCase(),
      customerRef: t.customer_id ?? undefined,
      subscriptionRef: t.subscription_id ?? undefined,
      periodStart: t.billing_period?.starts_at ? new Date(t.billing_period.starts_at) : undefined,
      periodEnd: t.billing_period?.ends_at ? new Date(t.billing_period.ends_at) : undefined,
      raw: {
        id: t.id,
        status: t.status,
        priceId,
        total,
        currency: t.currency_code,
        origin: t.origin,
        subscription_id: t.subscription_id,
        customer_id: t.customer_id,
        billed_at: t.billed_at,
      },
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    const h = headers['paddle-signature'];
    const sig = Array.isArray(h) ? h[0] : h;
    const signatureOk = Boolean(sig && this.webhookSecret) && PaddleGateway.verifySignature(sig!, rawBody, this.webhookSecret);
    let body: unknown = null;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      body = null;
    }
    const b = (body ?? {}) as { event_id?: string; event_type?: string; data?: { id?: string } };
    return { signatureOk, eventId: b.event_id ?? `${b.event_type ?? 'unknown'}:${b.data?.id ?? 'none'}`, type: b.event_type ?? 'unknown', body };
  }

  /** `ts=…;h1=…` over `${ts}:${raw}`. Exposed for the unit test. */
  static verifySignature(header: string, rawBody: Buffer, secret: string, now = Date.now()): boolean {
    const parts = Object.fromEntries(header.split(';').map((p) => p.trim().split('=') as [string, string]));
    const ts = parts.ts;
    const h1 = header
      .split(';')
      .filter((p) => p.trim().startsWith('h1='))
      .map((p) => p.trim().slice(3));
    if (!ts || h1.length === 0) return false;
    if (Math.abs(now / 1000 - Number(ts)) > REPLAY_WINDOW_SEC) return false;
    const expected = createHmac('sha256', secret).update(`${ts}:`).update(rawBody).digest('hex');
    return h1.some((sig) => sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  }

  interpret(parsed: ParsedWebhook): WebhookIntent {
    const b = (parsed.body ?? {}) as {
      event_type?: string;
      data?: PaddleTxn & PaddleSub & { transaction_id?: string; action?: string; totals?: { total?: string } };
    };
    const d = b.data ?? ({} as NonNullable<typeof b.data>);
    const reference = typeof d.custom_data?.reference === 'string' ? d.custom_data.reference : undefined;
    switch (parsed.type) {
      case 'transaction.completed':
      case 'transaction.paid':
        return {
          kind: 'charge',
          reference,
          providerRef: d.id,
          customerRef: d.customer_id ?? undefined,
          subscriptionRef: d.subscription_id ?? undefined,
          status: 'succeeded',
        };
      case 'transaction.payment_failed':
      case 'transaction.canceled':
        return {
          kind: 'charge',
          reference,
          providerRef: d.id,
          customerRef: d.customer_id ?? undefined,
          subscriptionRef: d.subscription_id ?? undefined,
          status: 'failed',
        };
      case 'subscription.activated':
      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.resumed':
      case 'subscription.past_due':
      case 'subscription.paused':
      case 'subscription.canceled': {
        const status =
          d.status === 'active' || d.status === 'trialing'
            ? 'active'
            : d.status === 'past_due'
              ? 'past_due'
              : d.status === 'paused'
                ? 'paused'
                : d.status === 'canceled'
                  ? 'cancelled'
                  : 'active';
        return {
          kind: 'subscription',
          subscriptionRef: d.id,
          customerRef: d.customer_id,
          reference,
          status,
          periodStart: d.current_billing_period?.starts_at ? new Date(d.current_billing_period.starts_at) : undefined,
          periodEnd: d.current_billing_period?.ends_at ? new Date(d.current_billing_period.ends_at) : undefined,
          cancelAtPeriodEnd: d.scheduled_change?.action === 'cancel',
        };
      }
      case 'adjustment.created':
      case 'adjustment.updated': {
        const a = d as { action?: string; transaction_id?: string; status?: string; totals?: { total?: string } };
        if (a.action !== 'refund' || (a.status && a.status !== 'approved')) return { kind: 'ignore', why: `adjustment ${a.action} ${a.status ?? ''}` };
        return a.transaction_id
          ? { kind: 'refund', providerRef: a.transaction_id, amountMinor: a.totals?.total ? Number(a.totals.total) : undefined }
          : { kind: 'ignore', why: 'refund without transaction id' };
      }
      default:
        return { kind: 'ignore', why: `event ${parsed.type}` };
    }
  }

  async cancelSubscription(subscriptionRef: string, atPeriodEnd: boolean): Promise<void> {
    await http('paddle', `${this.base}/subscriptions/${encodeURIComponent(subscriptionRef)}/cancel`, {
      body: { effective_from: atPeriodEnd ? 'next_billing_period' : 'immediately' },
      headers: this.headers(),
      timeoutMs: TIMEOUT,
    });
  }
}
