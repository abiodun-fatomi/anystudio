/**
 * The shape every payment gateway has to fit.
 *
 * Two gateways, one contract: Flutterwave for African currencies, Paddle as
 * merchant of record for everyone else. BillingService talks only to this
 * interface, so the rules that keep money honest — server-side prices,
 * signature then independent verification, idempotent ledger grants — are
 * written once and cannot be forgotten by a gateway.
 */

import type { Payment, PaymentProvider } from '@prisma/client';

export type Interval = 'month' | 'year';

/** What the customer is buying, priced by the server. */
export interface CheckoutItem {
  kind: 'pack' | 'plan';
  code: string;
  credits: number;
  interval?: Interval;
  /** Minor units of `currency` — what we expect the gateway to charge. */
  amountMinor: number;
  currency: string;
  /** The gateway's own id for this item (Paddle price id, Flutterwave payment-plan id), if it needs one. */
  providerRef?: string | number;
  label: string;
}

export interface CheckoutRequest {
  payment: Payment;
  item: CheckoutItem;
  customer: { email: string | null; name: string | null; phone: string | null };
  /** Where the gateway sends the person afterwards. Carries our reference. */
  returnUrl: string;
  /** The web origin, for gateways whose checkout page we host. */
  appOrigin: string;
}

export interface CheckoutSession {
  url: string;
  /** The gateway's id for the not-yet-paid charge, when it hands one out at creation. */
  providerRef?: string;
}

/**
 * The answer to "did they really pay?", from the gateway's own API — never
 * from the webhook body. `amountMinor`/`currency` are what was charged;
 * BillingService compares them with the Payment row.
 */
export type Verification =
  | {
      ok: true;
      providerRef: string;
      amountMinor: number;
      currency: string;
      /** Gateway customer id (or email, for gateways without one) — how later renewals are matched. */
      customerRef?: string;
      /** For plan purchases: the gateway's subscription id and period. */
      subscriptionRef?: string;
      periodStart?: Date;
      periodEnd?: Date;
      raw: unknown;
    }
  | { ok: false; state: 'pending' | 'failed'; reason: string; raw?: unknown };

/** A webhook after the signature check, before we have decided anything. */
export interface ParsedWebhook {
  signatureOk: boolean;
  /** Stable per event — a redelivery must produce the same id. */
  eventId: string;
  type: string;
  body: unknown;
}

/** What a webhook is asking us to do, in our words. */
export type WebhookIntent =
  | {
      kind: 'charge';
      /** Our reference, when the gateway echoed it. */
      reference?: string;
      providerRef?: string;
      customerRef?: string;
      subscriptionRef?: string;
      status: 'succeeded' | 'failed' | 'pending';
      /** Only when we cannot match a reference: which plan the gateway says renewed. */
      planRef?: string;
      customerEmail?: string;
    }
  | {
      kind: 'subscription';
      subscriptionRef: string;
      customerRef?: string;
      reference?: string;
      status: 'active' | 'past_due' | 'cancelled' | 'paused';
      periodStart?: Date;
      periodEnd?: Date;
      cancelAtPeriodEnd?: boolean;
    }
  | { kind: 'refund'; providerRef: string; amountMinor?: number }
  | { kind: 'ignore'; why: string };

export interface Gateway {
  readonly provider: PaymentProvider;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** Re-fetch the charge from the gateway. `hint` is the gateway id when the webhook or return URL carried one. */
  verify(payment: Payment, hint?: { providerRef?: string }): Promise<Verification>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook;
  interpret(parsed: ParsedWebhook): WebhookIntent;
  cancelSubscription(subscriptionRef: string, atPeriodEnd: boolean): Promise<void>;
}

/** Which gateway takes which currency. Anything not listed goes to Paddle. */
export const FLUTTERWAVE_CURRENCIES = new Set(['NGN', 'GHS', 'KES', 'ZAR', 'UGX', 'TZS', 'RWF', 'XOF', 'XAF', 'EGP', 'ETB', 'ZMW', 'MWK']);

export function providerForCurrency(currency: string): PaymentProvider {
  return FLUTTERWAVE_CURRENCIES.has(currency.toUpperCase()) ? 'FLUTTERWAVE' : 'PADDLE';
}

/** Currencies with no minor unit. Everything we sell in today has two decimals. */
const ZERO_DECIMAL = new Set(['UGX', 'RWF', 'XOF', 'XAF', 'JPY', 'KRW']);
export function toMinor(major: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? Math.round(major) : Math.round(major * 100);
}
export function toMajor(minor: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? minor : minor / 100;
}
