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

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Payment } from '@prisma/client';
import { ProviderError } from '@anystudio/shared';
import { http } from '../../provider/adapters/http';
import type { CheckoutRequest, CheckoutSession, Gateway, ParsedWebhook, RefundDiscoveryContext, Verification, WebhookIntent } from '../billing.types';
import { toMajor, toMinor } from '../billing.types';

const BASE = 'https://api.flutterwave.com/v3';
const TIMEOUT = 20_000;

type FlwScalarRef = number | string;

interface FlwPlan {
  id?: FlwScalarRef;
}

interface FlwCustomer {
  id?: FlwScalarRef;
  email?: string;
  customer_email?: string;
  name?: string;
}

interface FlwTx {
  id: FlwScalarRef;
  tx_ref?: string;
  reference?: string;
  flw_ref?: string;
  amount: number;
  charged_amount?: number;
  currency: string;
  status: string;
  payment_type?: string;
  customer?: FlwCustomer;
  plan?: FlwScalarRef | FlwPlan;
  payment_plan?: FlwScalarRef | FlwPlan;
  created_at?: string;
}

interface FlwRefund {
  id?: FlwScalarRef;
  tx_id?: FlwScalarRef;
  transaction_id?: FlwScalarRef;
  TransactionId?: FlwScalarRef;
  amount_refunded?: number;
  AmountRefunded?: number;
  currency?: string;
  status?: string;
  created_at?: string;
}

interface FlwChargeback {
  id?: FlwScalarRef;
  flw_ref?: string;
  transaction_id?: FlwScalarRef;
  amount?: number;
  currency?: string;
  status?: string;
}

interface FlwSubscription {
  id: FlwScalarRef;
  plan?: FlwScalarRef | FlwPlan;
  status?: string;
  customer?: FlwCustomer;
}

export class FlutterwaveGateway implements Gateway {
  readonly provider = 'FLUTTERWAVE' as const;
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
  ) {}

  private headers() {
    return { authorization: `Bearer ${this.secretKey}` };
  }

  checkoutAvailable(item: Pick<CheckoutRequest['item'], 'kind' | 'providerRef'>): boolean {
    // Standard one-off checkout is amount based. A recurring plan must name
    // the Flutterwave payment-plan id configured for its interval.
    return item.kind !== 'plan' || item.providerRef !== undefined;
  }

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
    const res = await http<{ status: string; data?: { link?: string } }>('flutterwave', `${BASE}/payments`, {
      body,
      headers: this.headers(),
      timeoutMs: TIMEOUT,
    });
    const url = res.json?.data?.link;
    if (!url) throw new Error(`flutterwave returned no checkout link: ${res.text.slice(0, 200)}`);
    return { url };
  }

  async verify(payment: Payment, hint?: { providerRef?: string }): Promise<Verification> {
    const id = hint?.providerRef ?? payment.providerRef;
    const url =
      id && /^\d+$/.test(id) ? `${BASE}/transactions/${id}/verify` : `${BASE}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(payment.reference)}`;
    let res;
    try {
      res = await http<{ status: string; data?: FlwTx }>('flutterwave', url, { headers: this.headers(), timeoutMs: TIMEOUT });
    } catch (e) {
      return { ok: false, state: 'pending', reason: e instanceof Error ? e.message : String(e) };
    }
    const tx = res.json?.data;
    if (!tx) return { ok: false, state: 'pending', reason: 'no transaction yet' };
    const reference = transactionReference(tx);
    const transactionPlanRef = planReference(tx);
    const transactionEmail = customerEmail(tx);
    const expected = paymentProviderContext(payment);
    if (reference !== payment.reference && payment.kind !== 'RENEWAL')
      return { ok: false, state: 'failed', reason: `reference mismatch: ${reference ?? 'missing'}`, raw: tx };
    if (tx.status !== 'successful') return { ok: false, state: tx.status === 'pending' ? 'pending' : 'failed', reason: `status ${tx.status}`, raw: tx };

    let subscriptionRef: string | undefined;
    let customerRef = transactionEmail;
    let subscriptionPlanRef: string | undefined;
    let subscription: FlwSubscription | undefined;
    if (payment.kind === 'SUBSCRIPTION' || payment.kind === 'RENEWAL') {
      try {
        subscription = await this.findSubscriptionByTransactionId(String(tx.id));
      } catch (e) {
        return { ok: false, state: 'pending', reason: `subscription lookup: ${e instanceof Error ? e.message : String(e)}`, raw: tx };
      }
      if (!subscription) return { ok: false, state: 'pending', reason: 'paid subscription is not queryable yet', raw: tx };

      subscriptionRef = String(subscription.id);
      subscriptionPlanRef = planReference(subscription);
      const subscriptionEmail = customerEmailValue(subscription.customer);
      customerRef = subscriptionEmail ?? transactionEmail;

      // Flutterwave's documented transaction verification response does not
      // include a plan. The subscription endpoint, keyed by the verified
      // transaction id, is the authoritative recurring-payment context.
      if (expected.catalogueRef && subscriptionPlanRef !== expected.catalogueRef)
        return { ok: false, state: 'failed', reason: `payment plan mismatch: ${subscriptionPlanRef ?? 'missing'}`, raw: { tx, subscription } };
      if (transactionPlanRef && subscriptionPlanRef && transactionPlanRef !== subscriptionPlanRef)
        return {
          ok: false,
          state: 'failed',
          reason: `transaction/subscription plan mismatch: ${transactionPlanRef} != ${subscriptionPlanRef}`,
          raw: { tx, subscription },
        };
      if (transactionEmail && subscriptionEmail && transactionEmail !== subscriptionEmail)
        return {
          ok: false,
          state: 'failed',
          reason: `transaction/subscription customer mismatch: ${transactionEmail} != ${subscriptionEmail}`,
          raw: { tx, subscription },
        };
      if (payment.kind === 'RENEWAL' && expected.customerRef && customerRef !== expected.customerRef)
        return { ok: false, state: 'failed', reason: `renewal customer mismatch: ${customerRef ?? 'missing'}`, raw: { tx, subscription } };
      if (payment.kind === 'RENEWAL' && expected.subscriptionRef && subscriptionRef !== expected.subscriptionRef)
        return { ok: false, state: 'failed', reason: `renewal subscription mismatch: ${subscriptionRef}`, raw: { tx, subscription } };
    }
    return {
      ok: true,
      providerRef: String(tx.id),
      amountMinor: toMinor(tx.amount, tx.currency),
      currency: tx.currency.toUpperCase(),
      customerRef,
      subscriptionRef,
      raw: {
        id: tx.id,
        tx_ref: reference,
        flw_ref: tx.flw_ref,
        amount: tx.amount,
        charged_amount: tx.charged_amount,
        currency: tx.currency,
        status: tx.status,
        payment_type: tx.payment_type,
        created_at: tx.created_at,
        ...(subscription
          ? {
              subscription: {
                id: subscription.id,
                plan: subscriptionPlanRef,
                status: subscription.status,
                customer: customerEmailValue(subscription.customer),
              },
            }
          : {}),
      },
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    const one = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    let signatureOk = false;
    const v3 = one('verif-hash');
    if (v3 && this.webhookSecret) signatureOk = safeEq(v3, this.webhookSecret);
    const v4 = one('flutterwave-signature');
    if (!signatureOk && v4 && this.webhookSecret) {
      signatureOk =
        safeEq(v4, createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex')) ||
        safeEq(v4, createHmac('sha256', this.webhookSecret).update(rawBody).digest('base64'));
    }
    let body: unknown = null;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      body = null;
    }
    const b = asRecord(body);
    const flatRefund = isFlatRefundWebhook(b);
    const data = flatRefund ? b : asRecord(b?.data);
    const type = stringValue(b?.event) ?? stringValue(b?.type) ?? (flatRefund ? 'refund.completed' : 'unknown');
    // A flat v3 refund's top-level `id` is the refund id, not a webhook id.
    const webhookId = scalarReference(b?.webhook_id) ?? (!flatRefund ? scalarReference(b?.id) : undefined);
    const dataId = scalarReference(data?.id) ?? transactionReference(data);
    // v3 payloads do not consistently include a webhook id. Hashing the raw
    // envelope is the safest final fallback: redelivery stays idempotent and
    // unrelated id-less events no longer all collapse to `${type}:none`.
    const fallbackId = dataId ?? createHash('sha256').update(rawBody).digest('hex');
    const eventId = webhookId ?? `${type}:${fallbackId}`;
    const normalizedBody = flatRefund ? { event: type, data: b } : body;
    return { signatureOk, eventId, type, body: normalizedBody };
  }

  interpret(parsed: ParsedWebhook): WebhookIntent {
    const b = asRecord(parsed.body) ?? {};
    const d = asRecord(b.data) ?? {};
    switch (parsed.type) {
      case 'charge.completed': {
        const gatewayStatus = stringValue(d?.status)?.toLowerCase();
        const status = gatewayStatus === 'successful' || gatewayStatus === 'succeeded' ? 'succeeded' : gatewayStatus === 'pending' ? 'pending' : 'failed';
        const planRef = planReference(d);
        const email = customerEmail(d);
        return {
          kind: 'charge',
          reference: transactionReference(d),
          providerRef: scalarReference(d?.id),
          customerRef: email,
          // A Flutterwave plan id is shared by all customers. Leaving
          // subscriptionRef unset makes BillingService use plan + email for
          // recurring-charge lookup instead of selecting an arbitrary member.
          planRef,
          customerEmail: email,
          status,
        };
      }
      case 'subscription.cancelled': {
        const subscriptionRef = scalarReference(d?.id);
        const catalogueRef = planReference(d);
        if (!subscriptionRef && !catalogueRef) return { kind: 'ignore', why: 'subscription cancellation without a plan or subscription id' };
        return {
          kind: 'subscription',
          ...(subscriptionRef ? { subscriptionRef } : {}),
          ...(catalogueRef ? { catalogueRef } : {}),
          customerRef: customerEmail(d),
          reference: transactionReference(d),
          status: 'cancelled',
          ...(webhookOccurredAt(b) ? { occurredAt: webhookOccurredAt(b) } : {}),
        };
      }
      case 'refund.completed':
      case 'charge.refunded': {
        const r = d as FlwRefund;
        const ref = refundTransactionRef(r);
        return ref
          ? {
              kind: 'refund',
              providerRef: ref,
              refundRef: scalarReference(r.id),
              status: refundState(r.status, false),
              amountMinor: refundAmountMinor(r, r.currency ?? ''),
              currency: r.currency?.toUpperCase(),
              reason: 'refund',
            }
          : { kind: 'ignore', why: 'refund without a transaction id' };
      }
      case 'chargeback.initiated':
      case 'chargeback.pending':
      case 'chargeback.accepted':
      case 'chargeback.declined':
      case 'chargeback.lost':
      case 'chargeback.won':
      case 'chargeback.reversed': {
        const chargeback = d as FlwChargeback;
        const adjustmentRef = chargeback.flw_ref
          ? `chargeback:${chargeback.flw_ref}`
          : chargeback.id !== undefined
            ? `chargeback-id:${String(chargeback.id)}`
            : undefined;
        if (!adjustmentRef) return { kind: 'ignore', why: 'chargeback without a stable id' };
        return {
          kind: 'refund',
          providerRef: scalarReference(chargeback.transaction_id),
          refundRef: adjustmentRef,
          status: chargebackState(chargeback.status),
          amountMinor: typeof chargeback.amount === 'number' && chargeback.currency ? toMinor(Math.abs(chargeback.amount), chargeback.currency) : undefined,
          currency: chargeback.currency?.toUpperCase(),
          reason: 'chargeback',
        };
      }
      default:
        return { kind: 'ignore', why: `event ${parsed.type}` };
    }
  }

  /** Resolve the per-customer subscription id; the stored providerRef is the shared payment-plan id. */
  async cancelSubscription(input: { providerRef: string; customerRef?: string; catalogueRef?: string }): Promise<void> {
    // New rows hold the true subscription id. During rollout, legacy rows
    // have providerRef === catalogueRef because the old code stored the shared
    // plan id there; only those rows need the email+plan lookup.
    const subscriptionRef =
      input.catalogueRef && input.providerRef === input.catalogueRef
        ? input.customerRef
          ? await this.findSubscriptionId(input.customerRef, input.catalogueRef)
          : null
        : input.providerRef;
    if (!subscriptionRef) throw new Error('Flutterwave could not resolve the customer subscription');
    await http('flutterwave', `${BASE}/subscriptions/${encodeURIComponent(subscriptionRef)}/cancel`, {
      method: 'PUT',
      headers: this.headers(),
      timeoutMs: TIMEOUT,
    });
  }

  async refund(payment: Payment, reason: string, context?: RefundDiscoveryContext) {
    if (!payment.providerRef) throw new Error('payment has no Flutterwave transaction id');
    let res;
    try {
      res = await http<{ status?: string; message?: string; data?: FlwRefund }>(
        'flutterwave',
        `${BASE}/transactions/${encodeURIComponent(payment.providerRef)}/refund`,
        {
          body: { amount: toMajor(payment.amountMinor, payment.currency), comments: reason.slice(0, 200) },
          headers: this.headers(),
          timeoutMs: TIMEOUT,
        },
      );
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'REQUEST_REJECTED' && err.meta.status === 409) {
        // A conflict commonly means the transaction already has a refund.
        // The POST outcome is therefore provider-known, not a reason to send
        // another refund; recover the existing refund from provider truth.
        return context ? this.discoverRefund(payment, context) : this.verifyRefund(payment);
      }
      if (err instanceof ProviderError && (err.kind === 'REQUEST_REJECTED' || err.kind === 'INVALID_INPUT')) {
        return { state: 'failed' as const, reason: err.message, amountMinor: payment.amountMinor, currency: payment.currency };
      }
      throw err;
    }
    if (res.json?.status !== 'success') {
      return {
        state: 'failed' as const,
        reason: `flutterwave refund rejected: ${res.json?.message ?? res.text.slice(0, 200)}`,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      };
    }
    const data = res.json.data;
    return {
      state: refundState(data?.status, false),
      providerRef: data?.id !== undefined ? String(data.id) : undefined,
      amountMinor: refundAmountMinor(data, payment.currency),
      currency: data?.currency?.toUpperCase() ?? payment.currency,
    };
  }

  async verifyRefund(payment: Payment, providerRef?: string) {
    if (providerRef?.startsWith('chargeback:') || providerRef?.startsWith('chargeback-id:')) {
      const chargeback = await this.findChargeback(providerRef);
      if (!chargeback) return { state: 'pending' as const, providerRef, reason: 'chargeback not queryable yet' };
      const transactionRef = scalarReference(chargeback.transaction_id);
      if (!transactionRef || !payment.providerRef || transactionRef !== payment.providerRef) {
        return { state: 'failed' as const, providerRef, reason: 'chargeback belongs to another or unknown transaction' };
      }
      const currency = chargeback.currency?.toUpperCase() ?? payment.currency;
      return {
        state: chargebackState(chargeback.status),
        providerRef: canonicalChargebackRef(chargeback) ?? providerRef,
        amountMinor: typeof chargeback.amount === 'number' && Number.isFinite(chargeback.amount) ? toMinor(Math.abs(chargeback.amount), currency) : undefined,
        currency,
        reason: chargeback.status ? `chargeback ${chargeback.status}` : 'chargeback status missing',
      };
    }
    let refund: FlwRefund | undefined;
    if (providerRef) {
      const res = await http<{ status?: string; data?: FlwRefund }>('flutterwave', `${BASE}/refunds/${encodeURIComponent(providerRef)}`, {
        headers: this.headers(),
        timeoutMs: TIMEOUT,
      });
      refund = res.json?.data;
    } else {
      if (!payment.providerRef) return { state: 'pending' as const, reason: 'payment has no Flutterwave transaction id' };
      const from = payment.createdAt.toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const res = await http<{ status?: string; data?: FlwRefund[] }>(
        'flutterwave',
        `${BASE}/refunds?from=${from}&to=${to}&id=${encodeURIComponent(payment.providerRef)}`,
        { headers: this.headers(), timeoutMs: TIMEOUT },
      );
      refund = (res.json?.data ?? []).find((row) => refundTransactionRef(row) === payment.providerRef);
    }
    if (!refund) return { state: 'pending' as const, reason: 'refund not found yet' };
    const transactionRef = refundTransactionRef(refund);
    if (transactionRef && payment.providerRef && transactionRef !== payment.providerRef) {
      return { state: 'failed' as const, providerRef: scalarReference(refund.id), reason: 'refund belongs to another transaction' };
    }
    return {
      state: refundState(refund.status, false),
      providerRef: scalarReference(refund.id) ?? providerRef,
      amountMinor: refundAmountMinor(refund, payment.currency),
      currency: refund.currency?.toUpperCase() ?? payment.currency,
      reason: refund.status ? `status ${refund.status}` : 'refund status missing',
    };
  }

  async discoverRefund(payment: Payment, context: RefundDiscoveryContext) {
    if (!payment.providerRef) return { state: 'pending' as const, reason: 'payment has no Flutterwave transaction id' };
    const from = context.since.toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const res = await http<{ status?: string; data?: FlwRefund[] }>(
      'flutterwave',
      `${BASE}/refunds?from=${from}&to=${to}&id=${encodeURIComponent(payment.providerRef)}`,
      { headers: this.headers(), timeoutMs: TIMEOUT },
    );
    const excluded = new Set(context.excludeProviderRefs);
    const since = context.since.getTime() - 30_000;
    const refund = (res.json?.data ?? [])
      .filter(
        (row) =>
          refundTransactionRef(row) === payment.providerRef &&
          scalarReference(row.id) !== undefined &&
          !excluded.has(scalarReference(row.id)!) &&
          (!row.created_at || !Number.isFinite(Date.parse(row.created_at)) || Date.parse(row.created_at) >= since),
      )
      .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''))[0];
    if (!refund) return { state: 'pending' as const, reason: 'new refund not found yet' };
    return {
      state: refundState(refund.status, false),
      providerRef: scalarReference(refund.id),
      amountMinor: refundAmountMinor(refund, payment.currency),
      currency: refund.currency?.toUpperCase() ?? payment.currency,
      reason: refund.status ? `status ${refund.status}` : 'refund status missing',
    };
  }

  /** Find the Flutterwave subscription id for a customer on a plan — needed to cancel, since the plan id is shared. */
  async findSubscriptionId(customerEmail: string, planId: string): Promise<string | null> {
    const res = await http<{ data?: Array<{ id: FlwScalarRef; plan: FlwScalarRef | FlwPlan; status: string; customer?: FlwCustomer }> }>(
      'flutterwave',
      `${BASE}/subscriptions?email=${encodeURIComponent(customerEmail)}&status=active`,
      { headers: this.headers(), timeoutMs: TIMEOUT },
    );
    const matches = (res.json?.data ?? []).filter((s) => planReference(s) === planId && s.status === 'active');
    // One account owner may bill several workspaces with the same email and
    // plan. Legacy rows lack the per-customer subscription id, so choosing the
    // first result could cancel the wrong workspace. Leave the durable command
    // pending for support instead of guessing.
    if (matches.length > 1) throw new Error('Flutterwave customer and plan matched multiple active subscriptions');
    return matches[0] ? String(matches[0].id) : null;
  }

  async resolveSubscriptionRef(transactionRef: string): Promise<string | undefined> {
    const subscription = await this.findSubscriptionByTransactionId(transactionRef);
    return subscription ? String(subscription.id) : undefined;
  }

  async resolveAdjustment(providerRef: string) {
    if (!providerRef.startsWith('chargeback:') && !providerRef.startsWith('chargeback-id:')) return undefined;
    const chargeback = await this.findChargeback(providerRef);
    const transactionRef = scalarReference(chargeback?.transaction_id);
    const canonical = chargeback ? canonicalChargebackRef(chargeback) : undefined;
    return transactionRef && canonical ? { paymentProviderRef: transactionRef, providerAdjustmentRef: canonical } : undefined;
  }

  private async findChargeback(providerRef: string): Promise<FlwChargeback | undefined> {
    const flwRef = providerRef.startsWith('chargeback:') ? providerRef.slice('chargeback:'.length) : undefined;
    // v3's single-chargeback lookup is keyed by flw_ref. Official webhooks
    // include it; an id-only legacy payload is retained for review rather than
    // guessed against the endpoint's transaction-id filter.
    if (!flwRef) return undefined;
    const res = await http<{ data?: FlwChargeback[] }>('flutterwave', `${BASE}/chargebacks?flw_ref=${encodeURIComponent(flwRef)}`, {
      headers: this.headers(),
      timeoutMs: TIMEOUT,
    });
    const matches = (res.json?.data ?? []).filter((row) => row.flw_ref === flwRef);
    if (matches.length > 1) throw new Error(`Flutterwave chargeback ${flwRef} is ambiguous`);
    return matches[0];
  }

  private async findSubscriptionByTransactionId(transactionId: string): Promise<FlwSubscription | undefined> {
    const res = await http<{ data?: FlwSubscription[] }>('flutterwave', `${BASE}/subscriptions?transaction_id=${encodeURIComponent(transactionId)}`, {
      headers: this.headers(),
      timeoutMs: TIMEOUT,
    });
    const matches = res.json?.data ?? [];
    if (matches.length > 1) throw new Error('transaction matched multiple Flutterwave subscriptions');
    return matches[0];
  }
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function scalarReference(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  return stringValue(value);
}

function embeddedReference(value: unknown): string | undefined {
  return scalarReference(value) ?? scalarReference(asRecord(value)?.id);
}

function planReference(value: unknown): string | undefined {
  const data = asRecord(value);
  return embeddedReference(data?.plan) ?? embeddedReference(data?.payment_plan);
}

function transactionReference(value: unknown): string | undefined {
  const data = asRecord(value);
  return scalarReference(data?.tx_ref) ?? scalarReference(data?.reference);
}

function customerEmail(value: unknown): string | undefined {
  const customer = asRecord(asRecord(value)?.customer);
  const email = stringValue(customer?.email) ?? stringValue(customer?.customer_email);
  return email?.toLowerCase();
}

function customerEmailValue(value: unknown): string | undefined {
  const customer = asRecord(value);
  const email = stringValue(customer?.email) ?? stringValue(customer?.customer_email);
  return email?.toLowerCase();
}

function refundTransactionRef(refund: FlwRefund): string | undefined {
  return scalarReference(refund.transaction_id ?? refund.tx_id ?? refund.TransactionId);
}

function isFlatRefundWebhook(value: Record<string, unknown> | undefined): boolean {
  if (!value || asRecord(value.data) || stringValue(value.event) || stringValue(value.type)) return false;
  const hasRefundAmount = typeof value.AmountRefunded === 'number' || typeof value.amount_refunded === 'number';
  const hasTransaction = scalarReference(value.TransactionId ?? value.transaction_id ?? value.tx_id) !== undefined;
  return hasRefundAmount && hasTransaction && scalarReference(value.id) !== undefined;
}

function refundAmountMinor(refund: FlwRefund | undefined, currency: string): number | undefined {
  const amount = refund?.amount_refunded ?? refund?.AmountRefunded;
  return typeof amount === 'number' && Number.isFinite(amount) ? toMinor(amount, refund?.currency ?? currency) : undefined;
}

function refundState(status: string | undefined, completedIsFinal: boolean): 'pending' | 'succeeded' | 'failed' | 'reversed' {
  const normalized = status?.trim().toLowerCase();
  if (normalized === 'reversed') return 'reversed';
  if (normalized === 'failed' || normalized === 'cancelled' || normalized === 'canceled') return 'failed';
  if (
    normalized === 'successful' ||
    normalized === 'succeeded' ||
    normalized === 'completed-bank-transfer' ||
    normalized === 'completed-momo' ||
    normalized === 'completed-mpgs' ||
    normalized === 'completed-offline' ||
    normalized === 'completed-preauth' ||
    (completedIsFinal && normalized === 'completed')
  )
    return 'succeeded';
  return 'pending';
}

function chargebackState(status: string | undefined): 'pending' | 'succeeded' | 'failed' | 'reversed' {
  const normalized = status?.trim().toLowerCase();
  // Flutterwave withholds the amount as soon as a chargeback is initiated.
  // Declining it starts a dispute but does not restore the withheld funds;
  // only won/reversed is an authoritative restoration.
  if (normalized === 'won' || normalized === 'reversed') return 'reversed';
  if (normalized === 'initiated' || normalized === 'pending' || normalized === 'accepted' || normalized === 'declined' || normalized === 'lost') {
    return 'succeeded';
  }
  return 'pending';
}

function canonicalChargebackRef(chargeback: FlwChargeback): string | undefined {
  if (chargeback.flw_ref) return `chargeback:${chargeback.flw_ref}`;
  return chargeback.id === undefined ? undefined : `chargeback-id:${String(chargeback.id)}`;
}

function webhookOccurredAt(body: Record<string, unknown>): Date | undefined {
  const raw = body.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const date = new Date(raw < 10_000_000_000 ? raw * 1000 : raw);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const value = stringValue(raw);
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function paymentProviderContext(payment: Payment): { catalogueRef?: string; subscriptionRef?: string; customerRef?: string } {
  const data = asRecord(payment.providerPayload);
  return {
    catalogueRef: scalarReference(data?.catalogueRef),
    subscriptionRef: scalarReference(data?.subscriptionRef),
    customerRef: stringValue(data?.customerRef)?.toLowerCase(),
  };
}
