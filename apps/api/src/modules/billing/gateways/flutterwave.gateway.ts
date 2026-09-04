/**
 * Flutterwave, v3 Standard checkout.
 *
 * Why v3 and not v4: at the time of writing v4 has no hosted checkout
 * ("coming soon"), and a hosted page is the whole point — no card data ever
 * touches us. v3's `/payments` returns a link; the person pays on
 * Flutterwave's page and comes back to `redirect_url` with
 * `?status=…&tx_ref=…&transaction_id=…`.
 *
 * Webhooks (v3) carry the dashboard's secret hash in `verif-hash` — a
 * shared secret, not an HMAC. We also accept v4's `flutterwave-signature`
 * (HMAC-SHA256 of the raw body) so switching the dashboard over later is a
 * config change. Either way the body is never trusted for value: we re-fetch
 * the transaction and compare amount, currency, status and reference.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Payment } from '@prisma/client';
import { http } from '../../provider/adapters/http';
import type { CheckoutRequest, CheckoutSession, Gateway, ParsedWebhook, Verification, WebhookIntent } from '../billing.types';
import { toMajor, toMinor } from '../billing.types';

const BASE = 'https://api.flutterwave.com/v3';
const TIMEOUT = 20_000;

interface FlwTx {
  id: number; tx_ref: string; flw_ref?: string; amount: number; charged_amount?: number; currency: string; status: string;
  payment_type?: string; customer?: { id?: number; email?: string; name?: string }; plan?: number | string; payment_plan?: number | string; created_at?: string;
}

export class FlutterwaveGateway implements Gateway {
  readonly provider = 'FLUTTERWAVE' as const;
  constructor(private readonly secretKey: string, private readonly webhookSecret: string) {}

  private headers() { return { authorization: `Bearer ${this.secretKey}` }; }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const body: Record<string, unknown> = {
      tx_ref: req.payment.reference,
      amount: toMajor(req.item.amountMinor, req.item.currency),
      currency: req.item.currency,
      redirect_url: req.returnUrl,
      customer: { email: req.customer.email ?? undefined, name: req.customer.name ?? undefined, phonenumber: req.customer.phone ?? undefined },
      customizations: { title: 'AnyStudio', description: req.item.label },
      meta: { paymentId: req.payment.id, workspaceId: req.payment.workspaceId, itemCode: req.item.code },
    };
    if (req.item.kind === 'plan') {
      if (req.item.providerRef === undefined) throw new Error(`plan ${req.item.code} has no Flutterwave payment plan for ${req.item.interval}`);
      body.payment_plan = req.item.providerRef;
    }
    const res = await http<{ status: string; data?: { link?: string } }>('flutterwave', `${BASE}/payments`, { body, headers: this.headers(), timeoutMs: TIMEOUT });
    const url = res.json?.data?.link;
    if (!url) throw new Error(`flutterwave returned no checkout link: ${res.text.slice(0, 200)}`);
    return { url };
  }

  async verify(payment: Payment, hint?: { providerRef?: string }): Promise<Verification> {
    const id = hint?.providerRef ?? payment.providerRef;
    const url = id && /^\d+$/.test(id)
      ? `${BASE}/transactions/${id}/verify`
      : `${BASE}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(payment.reference)}`;
    let res;
    try {
      res = await http<{ status: string; data?: FlwTx }>('flutterwave', url, { headers: this.headers(), timeoutMs: TIMEOUT });
    } catch (e) {
      return { ok: false, state: 'pending', reason: e instanceof Error ? e.message : String(e) };
    }
    const tx = res.json?.data;
    if (!tx) return { ok: false, state: 'pending', reason: 'no transaction yet' };
    if (tx.tx_ref !== payment.reference && payment.kind !== 'RENEWAL') return { ok: false, state: 'failed', reason: `reference mismatch: ${tx.tx_ref}`, raw: tx };
    if (tx.status !== 'successful') return { ok: false, state: tx.status === 'pending' ? 'pending' : 'failed', reason: `status ${tx.status}`, raw: tx };
    return {
      ok: true,
      providerRef: String(tx.id),
      amountMinor: toMinor(tx.amount, tx.currency),
      currency: tx.currency.toUpperCase(),
      customerRef: tx.customer?.email?.toLowerCase(),
      subscriptionRef: tx.plan !== undefined ? String(tx.plan) : tx.payment_plan !== undefined ? String(tx.payment_plan) : undefined,
      raw: { id: tx.id, tx_ref: tx.tx_ref, flw_ref: tx.flw_ref, amount: tx.amount, charged_amount: tx.charged_amount, currency: tx.currency, status: tx.status, payment_type: tx.payment_type, created_at: tx.created_at },
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    const one = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
    let signatureOk = false;
    const v3 = one('verif-hash');
    if (v3 && this.webhookSecret) signatureOk = safeEq(v3, this.webhookSecret);
    const v4 = one('flutterwave-signature');
    if (!signatureOk && v4 && this.webhookSecret) {
      signatureOk = safeEq(v4, createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex'))
        || safeEq(v4, createHmac('sha256', this.webhookSecret).update(rawBody).digest('base64'));
    }
    let body: unknown = null;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { body = null; }
    const b = (body ?? {}) as { event?: string; type?: string; webhook_id?: string; data?: { id?: number | string } };
    const type = b.event ?? b.type ?? 'unknown';
    const eventId = b.webhook_id ?? `${type}:${b.data?.id ?? 'none'}`;
    return { signatureOk, eventId, type, body };
  }

  interpret(parsed: ParsedWebhook): WebhookIntent {
    const b = (parsed.body ?? {}) as { event?: string; type?: string; data?: Partial<FlwTx> & { status?: string } };
    const d = b.data ?? {};
    switch (parsed.type) {
      case 'charge.completed': {
        const status = d.status === 'successful' || d.status === 'succeeded' ? 'succeeded' : d.status === 'pending' ? 'pending' : 'failed';
        const planRef = d.plan !== undefined ? String(d.plan) : d.payment_plan !== undefined ? String(d.payment_plan) : undefined;
        return { kind: 'charge', reference: d.tx_ref, providerRef: d.id !== undefined ? String(d.id) : undefined, customerRef: d.customer?.email?.toLowerCase(), subscriptionRef: planRef, planRef, customerEmail: d.customer?.email?.toLowerCase(), status };
      }
      case 'subscription.cancelled': {
        const sub = (b.data ?? {}) as { id?: number | string; plan?: number | string; customer?: { email?: string } };
        return { kind: 'subscription', subscriptionRef: String(sub.plan ?? sub.id ?? ''), customerRef: sub.customer?.email?.toLowerCase(), status: 'cancelled' };
      }
      case 'refund.completed':
      case 'charge.refunded': {
        const r = (b.data ?? {}) as { id?: number | string; tx_id?: number | string; transaction_id?: number | string; amount?: number; amount_refunded?: number; currency?: string };
        const ref = r.transaction_id ?? r.tx_id ?? r.id;
        return ref !== undefined ? { kind: 'refund', providerRef: String(ref), amountMinor: r.amount_refunded !== undefined && r.currency ? toMinor(r.amount_refunded, r.currency) : undefined } : { kind: 'ignore', why: 'refund without a transaction id' };
      }
      default:
        return { kind: 'ignore', why: `event ${parsed.type}` };
    }
  }

  /** Flutterwave subscriptions are cancelled by the subscription id, which is per customer-plan. */
  async cancelSubscription(subscriptionRef: string): Promise<void> {
    await http('flutterwave', `${BASE}/subscriptions/${encodeURIComponent(subscriptionRef)}/cancel`, { method: 'PUT', headers: this.headers(), timeoutMs: TIMEOUT });
  }

  /** Find the Flutterwave subscription id for a customer on a plan — needed to cancel, since the plan id is shared. */
  async findSubscriptionId(customerEmail: string, planId: string): Promise<string | null> {
    const res = await http<{ data?: Array<{ id: number; plan: number; status: string; customer?: { customer_email?: string } }> }>(
      'flutterwave', `${BASE}/subscriptions?email=${encodeURIComponent(customerEmail)}&status=active`, { headers: this.headers(), timeoutMs: TIMEOUT });
    const hit = (res.json?.data ?? []).find((s) => String(s.plan) === planId && s.status === 'active');
    return hit ? String(hit.id) : null;
  }
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
