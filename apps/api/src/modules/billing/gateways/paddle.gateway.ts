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
import { ProviderError } from '@anystudio/shared';
import { http } from '../../provider/adapters/http';
import type { CheckoutRequest, CheckoutSession, Gateway, ParsedWebhook, RefundDiscoveryContext, Verification, WebhookIntent } from '../billing.types';

const TIMEOUT = 20_000;
const REPLAY_WINDOW_SEC = 5 * 60;

interface PaddleTxn {
  id: string;
  status: string;
  customer_id?: string | null;
  subscription_id?: string | null;
  currency_code: string;
  origin?: 'api' | 'subscription_charge' | 'subscription_payment_method_change' | 'subscription_recurring' | 'subscription_update' | 'web';
  custom_data?: Record<string, unknown> | null;
  items?: Array<{ price?: { id?: string }; price_id?: string; quantity?: number }>;
  details?: { totals?: { subtotal?: string; discount?: string; total?: string; grand_total?: string; currency_code?: string } };
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

interface PaddleAdjustment {
  id?: string;
  action?: 'refund' | 'chargeback' | 'chargeback_reverse' | 'chargeback_warning' | 'chargeback_warning_reverse' | string;
  status?: 'pending_approval' | 'approved' | 'rejected' | 'reversed' | string;
  transaction_id?: string;
  totals?: { total?: string; currency_code?: string };
  created_at?: string;
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

  checkoutAvailable(item: Pick<CheckoutRequest['item'], 'kind' | 'providerRef'>): boolean {
    return item.kind === 'invoice' ? Boolean(process.env.PADDLE_USAGE_PRODUCT_ID) : item.providerRef !== undefined;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    // Packs and plans are catalogue prices. An invoice is a one-off amount,
    // so it goes as a non-catalogue price under the "usage" product — one
    // product in the Paddle catalogue, PADDLE_USAGE_PRODUCT_ID, priced per
    // transaction.
    let item: Record<string, unknown>;
    if (req.item.kind === 'invoice') {
      const product = process.env.PADDLE_USAGE_PRODUCT_ID;
      if (!product) throw new Error('invoice payments through Paddle need PADDLE_USAGE_PRODUCT_ID');
      item = {
        quantity: 1,
        price: {
          description: req.item.label,
          name: req.item.code,
          product_id: product,
          tax_mode: 'account_setting',
          unit_price: { amount: String(req.item.amountMinor), currency_code: req.item.currency },
          quantity: { minimum: 1, maximum: 1 },
        },
      };
    } else {
      if (!req.item.providerRef)
        throw new Error(`${req.item.kind} ${req.item.code} has no Paddle price id${req.item.interval ? ` for ${req.item.interval}` : ''}`);
      item = { price_id: String(req.item.providerRef), quantity: 1 };
    }
    const body = {
      items: [item],
      custom_data: { paymentId: req.payment.id, reference: req.payment.reference, workspaceId: req.payment.workspaceId, itemCode: req.item.code },
      currency_code: req.item.currency,
    };
    const res = await http<{ data?: PaddleTxn }>('paddle', `${this.base}/transactions`, { body, headers: this.headers(), timeoutMs: TIMEOUT });
    const txn = res.json?.data;
    if (!txn?.id) throw new Error(`paddle returned no transaction: ${res.text.slice(0, 200)}`);
    // Our own page hosts Paddle.js; the return URL is set on the checkout there.
    const url = `${req.appOrigin}/billing/pay?_ptxn=${encodeURIComponent(txn.id)}&ref=${encodeURIComponent(req.payment.reference)}&paymentId=${encodeURIComponent(req.payment.id)}`;
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
    if (!ours) return { ok: false, state: 'failed', reason: 'transaction does not carry our reference or subscription', raw: t };
    if ((payment.kind === 'SUBSCRIPTION' || payment.kind === 'RENEWAL') && t.status === 'paid' && !t.subscription_id) {
      // `paid` guarantees capture, but Paddle has not necessarily completed
      // the internal work that creates/attaches a subscription. Packs and
      // invoices may settle now; recurring purchases wait for either the
      // subscription id or the completed transaction.
      return { ok: false, state: 'pending', reason: 'paid transaction is awaiting subscription creation', raw: t };
    }
    if (t.status !== 'completed' && t.status !== 'paid') {
      return { ok: false, state: t.status === 'canceled' || t.status === 'past_due' ? 'failed' : 'pending', reason: `status ${t.status}`, raw: t };
    }
    const priceId = t.items?.[0]?.price?.id ?? t.items?.[0]?.price_id;
    const expectedPrice = (payment.providerPayload as { catalogueRef?: unknown } | null)?.catalogueRef;
    if (typeof expectedPrice === 'string' && priceId !== expectedPrice)
      return { ok: false, state: 'failed', reason: `price mismatch: ${priceId ?? 'missing'}`, raw: t };
    const totals = t.details?.totals;
    const total = Number(totals?.grand_total ?? totals?.total ?? '0');
    const currency = (totals?.currency_code ?? t.currency_code).toUpperCase();
    if (!Number.isFinite(total) || total <= 0) {
      return { ok: false, state: 'failed', reason: `invalid transaction total: ${String(totals?.grand_total ?? totals?.total ?? 'missing')}`, raw: t };
    }
    if (payment.kind === 'INVOICE') {
      // Invoice transactions use an inline price, so there is no immutable
      // Paddle catalogue price id to compare. Verify the undiscounted price
      // that we created instead: tax may legitimately make grand_total larger,
      // but a discount/credit must never settle the full local receivable.
      const subtotal = Number(totals?.subtotal);
      const discount = Number(totals?.discount ?? '0');
      if (
        currency !== payment.currency.toUpperCase() ||
        !Number.isFinite(subtotal) ||
        subtotal !== payment.amountMinor ||
        !Number.isFinite(discount) ||
        discount !== 0
      ) {
        return {
          ok: false,
          state: 'failed',
          reason: `invoice amount mismatch: subtotal ${String(totals?.subtotal ?? 'missing')}, discount ${String(totals?.discount ?? 'missing')}, currency ${currency}`,
          raw: t,
        };
      }
    }
    return {
      ok: true,
      providerRef: t.id,
      amountMinor: total,
      currency,
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
      occurred_at?: string;
      data?: PaddleTxn & PaddleSub & { transaction_id?: string; action?: string; totals?: { total?: string } };
    };
    const d = b.data ?? ({} as NonNullable<typeof b.data>);
    const reference = typeof d.custom_data?.reference === 'string' ? d.custom_data.reference : undefined;
    // Paddle copies checkout custom_data to a new subscription, then copies
    // that subscription data to transactions created from it. A renewal can
    // therefore carry the *initial* checkout reference. Let BillingService
    // match renewals by their unique transaction/subscription ids instead;
    // otherwise a renewal is mistaken for the already-settled first payment.
    const chargeReference = d.origin === 'subscription_recurring' ? undefined : reference;
    switch (parsed.type) {
      case 'transaction.completed':
      case 'transaction.paid':
        return {
          kind: 'charge',
          reference: chargeReference,
          providerRef: d.id,
          customerRef: d.customer_id ?? undefined,
          subscriptionRef: d.subscription_id ?? undefined,
          status: 'succeeded',
        };
      case 'transaction.payment_failed':
      case 'transaction.past_due':
      case 'transaction.canceled':
        return {
          kind: 'charge',
          reference: chargeReference,
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
          occurredAt: b.occurred_at ? new Date(b.occurred_at) : undefined,
        };
      }
      case 'adjustment.created':
      case 'adjustment.updated': {
        const a = d as PaddleAdjustment;
        // Paddle refunds the disputed amount when it creates either a
        // chargeback or an early chargeback warning. Their corresponding
        // reverse actions return the held amount.
        if (
          !['refund', 'chargeback', 'chargeback_reverse', 'chargeback_warning', 'chargeback_warning_reverse', 'credit', 'credit_reverse'].includes(
            a.action ?? '',
          )
        )
          return { kind: 'ignore', why: `adjustment ${a.action} ${a.status ?? ''}` };
        return a.transaction_id
          ? {
              kind: 'refund',
              providerRef: a.transaction_id,
              refundRef: a.id,
              status:
                a.action === 'chargeback_reverse' || a.action === 'chargeback_warning_reverse' || a.status === 'reversed'
                  ? 'reversed'
                  : paddleRefundState(a.status),
              amountMinor: a.totals?.total ? Math.abs(Number(a.totals.total)) : undefined,
              currency: a.totals?.currency_code?.toUpperCase(),
              reason: a.action?.startsWith('chargeback') ? 'chargeback' : 'refund',
            }
          : { kind: 'ignore', why: 'refund without transaction id' };
      }
      default:
        return { kind: 'ignore', why: `event ${parsed.type}` };
    }
  }

  async cancelSubscription(input: { providerRef: string; atPeriodEnd: boolean }): Promise<void> {
    await http('paddle', `${this.base}/subscriptions/${encodeURIComponent(input.providerRef)}/cancel`, {
      body: { effective_from: input.atPeriodEnd ? 'next_billing_period' : 'immediately' },
      headers: this.headers(),
      timeoutMs: TIMEOUT,
    });
  }

  /** A full refund is an adjustment naming every line item of the transaction. */
  async refund(payment: Payment, reason: string, context?: RefundDiscoveryContext) {
    if (!payment.providerRef) throw new Error('payment has no Paddle transaction id');
    let res;
    try {
      const txn = await http<{ data?: PaddleTxn & { details?: { line_items?: Array<{ id: string }> } } }>(
        'paddle',
        `${this.base}/transactions/${encodeURIComponent(payment.providerRef)}`,
        { headers: this.headers(), timeoutMs: TIMEOUT },
      );
      const items = txn.json?.data?.details?.line_items ?? [];
      if (items.length === 0) {
        return {
          state: 'failed' as const,
          reason: 'Paddle transaction has no refundable line items',
          amountMinor: payment.amountMinor,
          currency: payment.currency,
        };
      }
      res = await http<{ data?: PaddleAdjustment }>('paddle', `${this.base}/adjustments`, {
        body: {
          action: 'refund',
          transaction_id: payment.providerRef,
          reason: reason.slice(0, 200) || 'requested by customer',
          items: items.map((i) => ({ item_id: i.id, type: 'full' })),
        },
        headers: this.headers(),
        timeoutMs: TIMEOUT,
      });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'REQUEST_REJECTED' && err.meta.status === 409) {
        // Paddle rejects a duplicate adjustment rather than creating a
        // second refund. Resolve the existing adjustment by transaction id.
        return context ? this.discoverRefund(payment, context) : this.verifyRefund(payment);
      }
      if (err instanceof ProviderError && (err.kind === 'REQUEST_REJECTED' || err.kind === 'INVALID_INPUT')) {
        return { state: 'failed' as const, reason: err.message, amountMinor: payment.amountMinor, currency: payment.currency };
      }
      throw err;
    }
    const adjustment = res.json?.data;
    const id = adjustment?.id;
    if (!id) throw new Error(`paddle refund: ${res.text.slice(0, 200)}`);
    return {
      state: paddleRefundState(adjustment?.status),
      providerRef: id,
      amountMinor: adjustment?.totals?.total ? Math.abs(Number(adjustment.totals.total)) : payment.amountMinor,
      currency: adjustment?.totals?.currency_code?.toUpperCase() ?? payment.currency,
      reason: adjustment?.status ? `status ${adjustment.status}` : undefined,
      providerAction: adjustment?.action,
      reversalMode: 'separate_adjustment' as const,
    };
  }

  async verifyRefund(payment: Payment, providerRef?: string) {
    let adjustment: PaddleAdjustment | undefined;
    if (providerRef) {
      const res = await http<{ data?: PaddleAdjustment }>('paddle', `${this.base}/adjustments/${encodeURIComponent(providerRef)}`, {
        headers: this.headers(),
        timeoutMs: TIMEOUT,
      });
      adjustment = res.json?.data;
    } else {
      if (!payment.providerRef) return { state: 'pending' as const, reason: 'payment has no Paddle transaction id' };
      const res = await http<{ data?: PaddleAdjustment[] }>(
        'paddle',
        `${this.base}/adjustments?transaction_id=${encodeURIComponent(payment.providerRef)}&action=refund&per_page=10`,
        { headers: this.headers(), timeoutMs: TIMEOUT },
      );
      adjustment = (res.json?.data ?? []).find((row) => row.action === 'refund' && row.transaction_id === payment.providerRef);
    }
    return paddleAdjustmentVerification(payment, adjustment, providerRef);
  }

  async discoverRefund(payment: Payment, context: RefundDiscoveryContext) {
    if (!payment.providerRef) return { state: 'pending' as const, reason: 'payment has no Paddle transaction id' };
    const res = await http<{ data?: PaddleAdjustment[] }>(
      'paddle',
      `${this.base}/adjustments?transaction_id=${encodeURIComponent(payment.providerRef)}&action=refund&per_page=50`,
      { headers: this.headers(), timeoutMs: TIMEOUT },
    );
    const excluded = new Set(context.excludeProviderRefs);
    const since = context.since.getTime() - 30_000;
    const adjustment = (res.json?.data ?? [])
      .filter(
        (row) =>
          row.action === 'refund' &&
          row.transaction_id === payment.providerRef &&
          Boolean(row.id) &&
          !excluded.has(row.id!) &&
          (!row.created_at || !Number.isFinite(Date.parse(row.created_at)) || Date.parse(row.created_at) >= since),
      )
      .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''))[0];
    return paddleAdjustmentVerification(payment, adjustment);
  }
}

function paddleAdjustmentVerification(payment: Payment, adjustment: PaddleAdjustment | undefined, providerRef?: string) {
  if (!adjustment) return { state: 'pending' as const, reason: 'refund not found yet' };
  if (
    !['refund', 'chargeback', 'chargeback_reverse', 'chargeback_warning', 'chargeback_warning_reverse', 'credit', 'credit_reverse'].includes(
      adjustment.action ?? '',
    )
  )
    return { state: 'failed' as const, providerRef: adjustment.id, reason: `unexpected action ${adjustment.action}` };
  if (payment.providerRef && adjustment.transaction_id !== payment.providerRef)
    return { state: 'failed' as const, providerRef: adjustment.id, reason: 'refund belongs to another transaction' };
  return {
    state:
      adjustment.action === 'chargeback_reverse' || adjustment.action === 'chargeback_warning_reverse' || adjustment.status === 'reversed'
        ? ('reversed' as const)
        : paddleRefundState(adjustment.status),
    providerRef: adjustment.id ?? providerRef,
    amountMinor: adjustment.totals?.total ? Math.abs(Number(adjustment.totals.total)) : undefined,
    currency: adjustment.totals?.currency_code?.toUpperCase(),
    reason: adjustment.status ? `status ${adjustment.status}` : 'adjustment status missing',
    providerAction: adjustment.action,
    // Paddle creates a separate *_reverse adjustment and also changes the
    // original adjustment's status to `reversed`. Carry that provider
    // invariant across the adapter boundary so BillingService can count the
    // two envelopes as one economic reversal in any delivery order.
    reversalMode: 'separate_adjustment' as const,
  };
}

function paddleRefundState(status: string | undefined): 'pending' | 'succeeded' | 'failed' | 'reversed' {
  if (status === 'approved') return 'succeeded';
  if (status === 'rejected') return 'failed';
  if (status === 'reversed') return 'reversed';
  return 'pending';
}
