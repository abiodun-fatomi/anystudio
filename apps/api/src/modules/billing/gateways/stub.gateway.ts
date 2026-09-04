/**
 * A gateway that takes no money, for development and tests.
 *
 * Checkout sends the person straight to the return URL; verification
 * succeeds for the row's own amount unless the payment's providerPayload
 * says otherwise (`{ stub: 'pending' | 'failed' | 'short' }`), which is how
 * the tests exercise the unhappy paths without a mock framework. Webhooks
 * are accepted when the secret matches `x-stub-signature`.
 *
 * Refused in production by the registry — a gateway that grants credits
 * for free is not a fallback, it is a hole.
 */

import type { Payment } from '@prisma/client';
import type { CheckoutRequest, CheckoutSession, Gateway, ParsedWebhook, Verification, WebhookIntent } from '../billing.types';

export class StubGateway implements Gateway {
  readonly provider = 'STUB' as const;
  constructor(private readonly secret = 'stub') {}

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const url = new URL(req.returnUrl);
    url.searchParams.set('stub', '1');
    url.searchParams.set('transaction_id', `stub_${req.payment.id.slice(0, 8)}`);
    return { url: url.toString(), providerRef: `stub_${req.payment.id.slice(0, 8)}` };
  }

  async verify(payment: Payment, hint?: { providerRef?: string }): Promise<Verification> {
    const mode = (payment.providerPayload as { stub?: string } | null)?.stub;
    if (mode === 'pending') return { ok: false, state: 'pending', reason: 'stub: still pending' };
    if (mode === 'failed') return { ok: false, state: 'failed', reason: 'stub: declined' };
    return {
      ok: true,
      providerRef: hint?.providerRef ?? payment.providerRef ?? `stub_${payment.id.slice(0, 8)}`,
      amountMinor: mode === 'short' ? Math.floor(payment.amountMinor / 2) : payment.amountMinor,
      currency: mode === 'wrong_currency' ? 'XXX' : payment.currency,
      customerRef: 'stub-customer',
      subscriptionRef: payment.kind === 'PACK' ? undefined : `stubsub_${payment.workspaceId.slice(0, 8)}`,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + (payment.interval === 'year' ? 365 : 30) * 24 * 3600_000),
      raw: { stub: true },
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    const sig = headers['x-stub-signature'];
    let body: unknown = null;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { body = null; }
    const b = (body ?? {}) as { id?: string; type?: string };
    return { signatureOk: (Array.isArray(sig) ? sig[0] : sig) === this.secret, eventId: b.id ?? `${b.type}:none`, type: b.type ?? 'unknown', body };
  }

  interpret(parsed: ParsedWebhook): WebhookIntent {
    const b = (parsed.body ?? {}) as { type?: string; reference?: string; providerRef?: string; status?: 'succeeded' | 'failed' | 'pending'; subscriptionRef?: string; subStatus?: 'active' | 'past_due' | 'cancelled' | 'paused' };
    if (parsed.type === 'charge') return { kind: 'charge', reference: b.reference, providerRef: b.providerRef, status: b.status ?? 'succeeded', subscriptionRef: b.subscriptionRef };
    if (parsed.type === 'subscription' && b.subscriptionRef) return { kind: 'subscription', subscriptionRef: b.subscriptionRef, status: b.subStatus ?? 'active', reference: b.reference };
    if (parsed.type === 'refund' && b.providerRef) return { kind: 'refund', providerRef: b.providerRef };
    return { kind: 'ignore', why: 'stub' };
  }

  async cancelSubscription(): Promise<void> { /* nothing to cancel */ }
}
