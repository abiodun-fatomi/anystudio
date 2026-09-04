/**
 * Billing: turning money into credits without ever trusting the client, the
 * webhook body, or a single delivery.
 *
 * THE ORDER OF THINGS
 * -------------------
 *   1. The server prices the item and writes a PENDING Payment row.
 *   2. The person pays on the gateway's hosted page.
 *   3. Something tells us it happened — the webhook, or the return page
 *      asking us to check. Either way we RE-FETCH the charge from the
 *      gateway and compare it with the row (settle()).
 *   4. Credits are granted through the ledger with `payment:<id>` as the
 *      idempotency key. A webhook delivered five times, plus the return
 *      page checking twice, grants once.
 *
 * Nothing in a webhook body moves money. It is a hint about which row to
 * look at; the gateway's API is the witness.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type Payment, type PaymentProvider, type Plan, type CreditPack, type Subscription } from '@prisma/client';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { authLog } from '../auth/auth.log';
import { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/policy';
import { LedgerService } from '../ledger/ledger.service';
import { GatewayRegistry } from './gateways/gateway.registry';
import { FlutterwaveGateway } from './gateways/flutterwave.gateway';
import { toMinor, type CheckoutItem, type Gateway, type Interval, type Verification, type WebhookIntent } from './billing.types';
import type { CheckoutDto, PaymentsQueryDto } from './billing.dto';

type Refs = Record<string, Record<string, string | number> | undefined>;

const BUYERS = new Set(['OWNER', 'ADMIN', 'BILLING']);

@Injectable()
export class BillingService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly gateways: GatewayRegistry,
    private readonly auth: AuthService,
  ) {}

  // -------------------------------------------------------------- catalogue

  /** Packs and plans priced in the workspace's currency, and what it is on today. */
  async catalogue(workspaceId: string) {
    const ws = await this.workspace(workspaceId);
    const currency = ws.currency.toUpperCase();
    let provider: PaymentProvider | null = null;
    let gateway: Gateway | null = null;
    try { gateway = this.gateways.forCurrency(currency); provider = gateway.provider; } catch { provider = null; }
    const [packs, plans, subscription] = await Promise.all([
      this.db.creditPack.findMany({ where: { active: true }, orderBy: { sort: 'asc' } }),
      this.db.plan.findMany({ where: { active: true }, orderBy: { sort: 'asc' } }),
      this.currentSubscription(workspaceId),
    ]);
    const price = (by: unknown) => priceIn(by, currency);
    return {
      currency,
      provider,
      available: provider !== null,
      packs: packs.map((p) => ({ code: p.code, credits: p.credits, price: price(p.priceByMarket), canBuy: provider !== null && price(p.priceByMarket) !== null && hasRef(p.providerRefs, provider, 'once') })),
      plans: plans.map((p) => ({
        code: p.code, credits: p.credits,
        month: { price: price(p.priceByMarket), canBuy: provider !== null && price(p.priceByMarket) !== null && hasRef(p.providerRefs, provider, 'month') },
        year: p.yearlyPriceByMarket ? { price: price(p.yearlyPriceByMarket), canBuy: provider !== null && price(p.yearlyPriceByMarket) !== null && hasRef(p.providerRefs, provider, 'year') } : null,
        current: subscription?.planCode === p.code,
      })),
      subscription: subscription ? this.subscriptionView(subscription) : null,
    };
  }

  // --------------------------------------------------------------- checkout

  /**
   * Price the item, write the row, get a hosted checkout URL. The row exists
   * before the person leaves, so a payment that succeeds while our webhook
   * endpoint is down has something to land on.
   */
  async checkout(actor: Actor, workspaceId: string, dto: CheckoutDto, req: Request) {
    this.assertBuyer(actor, workspaceId);
    const ws = await this.workspace(workspaceId);
    const currency = ws.currency.toUpperCase();
    const gateway = this.gateways.forCurrency(currency);
    const item = await this.priceItem(dto, currency, gateway.provider);
    if (item.kind === 'plan') {
      const current = await this.currentSubscription(workspaceId);
      if (current && !current.cancelAtPeriodEnd) throw new ConflictError(`This workspace is already on ${current.planCode}. Cancel it first, or buy a pack instead.`);
    }
    const user = await this.db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true, name: true, phone: true } });
    const reference = `as_${item.kind}_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
    const payment = await this.db.payment.create({
      data: {
        workspaceId, userId: actor.userId, provider: gateway.provider, kind: item.kind === 'pack' ? 'PACK' : 'SUBSCRIPTION',
        reference, itemCode: item.code, interval: item.interval, credits: item.credits, amountMinor: item.amountMinor, currency: item.currency,
      },
    });
    const origin = this.auth.publicOrigin(req);
    let session;
    try {
      session = await gateway.createCheckout({ payment, item, customer: user, returnUrl: `${origin}/billing/return?ref=${reference}`, appOrigin: origin });
    } catch (e) {
      await this.db.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureReason: `checkout: ${e instanceof Error ? e.message : String(e)}` } });
      logger.error({ err: e, paymentId: payment.id, provider: gateway.provider, item: item.code }, 'checkout creation failed');
      throw new ConflictError('The payment page could not be opened. Nothing was charged — try again in a moment.');
    }
    await this.db.payment.update({ where: { id: payment.id }, data: { checkoutUrl: session.url, providerRef: session.providerRef } });
    authLog('billing.checkout', 'succeeded', { userId: actor.userId, workspaceId, paymentId: payment.id, provider: gateway.provider, item: item.code, interval: item.interval, amountMinor: item.amountMinor, currency }, req);
    return { paymentId: payment.id, reference, provider: gateway.provider, url: session.url, credits: item.credits, amountMinor: item.amountMinor, currency };
  }

  // ------------------------------------------------------------- settlement

  /** The return page asking "did it go through?". Verifies with the gateway and settles. */
  async verifyPayment(workspaceId: string, paymentId: string, hint: { providerRef?: string }, req?: Request) {
    const payment = await this.db.payment.findFirst({ where: { id: paymentId, workspaceId } });
    if (!payment) throw new NotFoundError('payment');
    if (payment.status !== 'PENDING') return this.paymentView(payment);
    const gateway = this.gateways.get(payment.provider);
    if (!gateway) throw new NotFoundError('payment gateway');
    const v = await gateway.verify(payment, hint.providerRef ? { providerRef: hint.providerRef } : undefined);
    const settled = await this.settle(payment, v, 'return');
    if (req) authLog('billing.verify', settled.status === 'SUCCEEDED' ? 'succeeded' : settled.status === 'FAILED' ? 'refused' : 'succeeded', { paymentId, status: settled.status, via: 'return' }, req);
    return this.paymentView(settled);
  }

  /**
   * Apply a verification to a row. Idempotent: a SUCCEEDED row is returned
   * untouched, and the ledger key makes the grant itself single-shot even
   * if two verifications race past the status read.
   */
  private async settle(payment: Payment, v: Verification, via: 'webhook' | 'return'): Promise<Payment> {
    const fresh = await this.db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (fresh.status === 'SUCCEEDED' || fresh.status === 'REFUNDED') return fresh;

    if (!v.ok) {
      if (v.state === 'failed') {
        logger.warn({ paymentId: fresh.id, provider: fresh.provider, reason: v.reason, via }, 'payment failed');
        return this.db.payment.update({ where: { id: fresh.id }, data: { status: 'FAILED', failureReason: v.reason, providerPayload: (v.raw ?? undefined) as Prisma.InputJsonValue | undefined } });
      }
      logger.info({ paymentId: fresh.id, provider: fresh.provider, reason: v.reason, via }, 'payment still pending');
      return fresh;
    }

    // The row is the contract. Flutterwave charges the number we sent, so it
    // must match; Paddle prices in its own currency with its own tax, so we
    // record what it charged — the price id was checked at checkout.
    if (fresh.provider !== 'PADDLE') {
      const mismatch = v.currency !== fresh.currency ? `currency ${v.currency} != ${fresh.currency}` : v.amountMinor < fresh.amountMinor ? `amount ${v.amountMinor} < ${fresh.amountMinor}` : null;
      if (mismatch) {
        // Money moved and does not match the row. This is the one line that must page someone.
        logger.error({ paymentId: fresh.id, provider: fresh.provider, providerRef: v.providerRef, mismatch, via }, 'PAYMENT MISMATCH: charged amount does not match the priced row; credits withheld');
        return this.db.payment.update({ where: { id: fresh.id }, data: { status: 'FAILED', failureReason: `mismatch: ${mismatch}`, providerRef: v.providerRef, providerPayload: v.raw as Prisma.InputJsonValue } });
      }
    }

    const wallet = await this.db.wallet.findUniqueOrThrow({ where: { workspaceId: fresh.workspaceId }, select: { id: true } });
    const entry = await this.ledger.purchase({
      walletId: wallet.id, amount: fresh.credits, idempotencyKey: `payment:${fresh.id}`, referenceId: fresh.id,
      reason: fresh.kind === 'PACK' ? `Credit pack ${fresh.itemCode}` : fresh.kind === 'RENEWAL' ? `${fresh.itemCode} plan renewed` : `${fresh.itemCode} plan`,
    });

    let subscriptionId: string | null = fresh.subscriptionId;
    if (fresh.kind !== 'PACK') {
      const sub = await this.upsertSubscription(fresh, v);
      subscriptionId = sub.id;
    }
    const updated = await this.db.payment.update({
      where: { id: fresh.id },
      data: {
        status: 'SUCCEEDED', providerRef: v.providerRef, amountMinor: fresh.provider === 'PADDLE' && v.amountMinor > 0 ? v.amountMinor : fresh.amountMinor,
        currency: fresh.provider === 'PADDLE' ? v.currency : fresh.currency, providerPayload: v.raw as Prisma.InputJsonValue, ledgerEntryId: entry.id, subscriptionId, failureReason: null,
      },
    });
    logger.info({ paymentId: fresh.id, workspaceId: fresh.workspaceId, provider: fresh.provider, providerRef: v.providerRef, credits: fresh.credits, amountMinor: updated.amountMinor, currency: updated.currency, kind: fresh.kind, via, ledgerEntryId: entry.id }, 'payment settled; credits granted');
    return updated;
  }

  private async upsertSubscription(payment: Payment, v: Extract<Verification, { ok: true }>): Promise<Subscription> {
    const existing = payment.subscriptionId
      ? await this.db.subscription.findUnique({ where: { id: payment.subscriptionId } })
      : await this.db.subscription.findFirst({ where: { workspaceId: payment.workspaceId, status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } });
    const periodEnd = v.periodEnd ?? new Date(Date.now() + (payment.interval === 'year' ? 365 : 30) * 24 * 3600_000);
    const data = {
      provider: payment.provider, providerRef: v.subscriptionRef ?? existing?.providerRef ?? null, planCode: payment.itemCode, interval: payment.interval ?? 'month',
      status: 'ACTIVE' as const, currentPeriodStart: v.periodStart ?? new Date(), currentPeriodEnd: periodEnd, customerRef: v.customerRef ?? existing?.customerRef ?? null, cancelAtPeriodEnd: false, cancelledAt: null,
    };
    if (existing) return this.db.subscription.update({ where: { id: existing.id }, data });
    return this.db.subscription.create({ data: { workspaceId: payment.workspaceId, ...data } });
  }

  // --------------------------------------------------------------- webhooks

  /**
   * One entry point per gateway. Records the receipt first (so "did they
   * call us?" is always answerable), checks the signature, then acts on the
   * intent. Always 200 once recorded, because a gateway that is retried for
   * our own processing bug will retry into the same bug; the receipt row
   * carries the error and the sweeper can re-drive it.
   */
  async handleWebhook(provider: PaymentProvider, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ status: string; outcome?: string }> {
    const gateway = this.gateways.get(provider);
    if (!gateway) { logger.warn({ provider }, 'webhook for a gateway that is not configured'); return { status: 'ignored' }; }
    const parsed = gateway.parseWebhook(rawBody, headers);
    let receipt;
    try {
      receipt = await this.db.webhookReceipt.create({ data: { provider, eventId: parsed.eventId, eventType: parsed.type, signatureOk: parsed.signatureOk, payload: (parsed.body ?? { raw: rawBody.toString('utf8').slice(0, 4000) }) as Prisma.InputJsonValue } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        logger.info({ provider, eventId: parsed.eventId, type: parsed.type }, 'webhook redelivered; already recorded');
        return { status: 'duplicate' };
      }
      throw e;
    }
    if (!parsed.signatureOk) {
      logger.warn({ provider, eventId: parsed.eventId, type: parsed.type, receiptId: receipt.id }, 'webhook signature rejected');
      await this.db.webhookReceipt.update({ where: { id: receipt.id }, data: { processedAt: new Date(), outcome: 'bad_signature' } });
      return { status: 'rejected' };
    }
    const intent = gateway.interpret(parsed);
    let outcome = 'ignored';
    let error: string | undefined;
    try {
      outcome = await this.act(gateway, intent);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      outcome = 'error';
      logger.error({ err: e, provider, eventId: parsed.eventId, type: parsed.type, receiptId: receipt.id }, 'webhook processing failed');
    }
    await this.db.webhookReceipt.update({ where: { id: receipt.id }, data: { processedAt: new Date(), outcome, error } });
    logger.info({ provider, eventId: parsed.eventId, type: parsed.type, outcome, receiptId: receipt.id }, 'webhook processed');
    return { status: 'ok', outcome };
  }

  private async act(gateway: Gateway, intent: WebhookIntent): Promise<string> {
    switch (intent.kind) {
      case 'ignore':
        return `ignored: ${intent.why}`;
      case 'charge': {
        let payment = intent.reference ? await this.db.payment.findUnique({ where: { reference: intent.reference } }) : null;
        if (!payment && intent.providerRef) payment = await this.db.payment.findFirst({ where: { provider: gateway.provider, providerRef: intent.providerRef } });
        if (!payment && intent.status === 'succeeded') payment = await this.renewalPayment(gateway.provider, intent);
        if (!payment) return 'no_payment';
        if (intent.status === 'failed') {
          if (payment.status === 'PENDING') await this.db.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureReason: 'gateway reported failure' } });
          return payment.status === 'PENDING' ? 'failed' : 'already_settled';
        }
        if (intent.status === 'pending') return 'pending';
        if (payment.status !== 'PENDING') return 'already_settled';
        const v = await gateway.verify(payment, intent.providerRef ? { providerRef: intent.providerRef } : undefined);
        const settled = await this.settle(payment, v, 'webhook');
        return settled.status === 'SUCCEEDED' ? 'granted' : settled.status === 'FAILED' ? `failed: ${settled.failureReason ?? ''}` : 'pending';
      }
      case 'subscription': {
        let sub = await this.db.subscription.findFirst({ where: { provider: gateway.provider, providerRef: intent.subscriptionRef } });
        if (!sub && intent.reference) {
          const p = await this.db.payment.findUnique({ where: { reference: intent.reference } });
          if (p?.subscriptionId) sub = await this.db.subscription.findUnique({ where: { id: p.subscriptionId } });
          if (!sub && p) sub = await this.db.subscription.findFirst({ where: { workspaceId: p.workspaceId, status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } });
        }
        if (!sub) return 'no_subscription';
        const status = intent.status === 'active' ? 'ACTIVE' : intent.status === 'past_due' ? 'PAST_DUE' : intent.status === 'paused' ? 'PAUSED' : 'CANCELLED';
        await this.db.subscription.update({
          where: { id: sub.id },
          data: {
            status, providerRef: sub.providerRef ?? intent.subscriptionRef, customerRef: intent.customerRef ?? sub.customerRef,
            currentPeriodStart: intent.periodStart ?? sub.currentPeriodStart, currentPeriodEnd: intent.periodEnd ?? sub.currentPeriodEnd,
            cancelAtPeriodEnd: intent.cancelAtPeriodEnd ?? sub.cancelAtPeriodEnd, cancelledAt: status === 'CANCELLED' ? (sub.cancelledAt ?? new Date()) : sub.cancelledAt,
          },
        });
        logger.info({ subscriptionId: sub.id, workspaceId: sub.workspaceId, status, cancelAtPeriodEnd: intent.cancelAtPeriodEnd }, 'subscription updated from webhook');
        return `subscription_${status.toLowerCase()}`;
      }
      case 'refund': {
        const payment = await this.db.payment.findFirst({ where: { provider: gateway.provider, providerRef: intent.providerRef } });
        if (!payment) return 'no_payment';
        if (payment.status === 'REFUNDED') return 'already_refunded';
        const wallet = await this.db.wallet.findUniqueOrThrow({ where: { workspaceId: payment.workspaceId }, select: { id: true } });
        let note: string | null = null;
        try {
          await this.ledger.clawback({ walletId: wallet.id, amount: payment.credits, idempotencyKey: `payment:${payment.id}`, referenceId: payment.id, reason: `Refund of ${payment.itemCode}` });
        } catch (e) {
          note = `clawback failed: ${e instanceof Error ? e.message : String(e)}`;
          logger.error({ err: e, paymentId: payment.id, workspaceId: payment.workspaceId, credits: payment.credits }, 'refund received but credits could not be taken back (already spent?) — needs a person');
        }
        await this.db.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED', refundedAt: new Date(), failureReason: note } });
        return note ? 'refunded_clawback_failed' : 'refunded';
      }
    }
  }

  /**
   * A charge we have no row for, on a subscription we do: the gateway
   * renewed it. Write the RENEWAL row so the settlement path is the same one
   * a first purchase takes.
   */
  private async renewalPayment(provider: PaymentProvider, intent: Extract<WebhookIntent, { kind: 'charge' }>): Promise<Payment | null> {
    const where: Prisma.SubscriptionWhereInput = { provider, status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } };
    if (intent.subscriptionRef) where.providerRef = intent.subscriptionRef;
    else if (intent.planRef && intent.customerEmail) { where.providerRef = intent.planRef; where.customerRef = intent.customerEmail; }
    else return null;
    const sub = await this.db.subscription.findFirst({ where, include: { plan: true, workspace: { select: { currency: true } } } });
    if (!sub) return null;
    const currency = sub.workspace.currency.toUpperCase();
    const by = sub.interval === 'year' ? sub.plan.yearlyPriceByMarket : sub.plan.priceByMarket;
    const price = priceIn(by, currency) ?? 0;
    const payment = await this.db.payment.create({
      data: {
        workspaceId: sub.workspaceId, provider, kind: 'RENEWAL', reference: `as_renew_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`,
        providerRef: intent.providerRef, itemCode: sub.planCode, interval: sub.interval, credits: sub.plan.credits, amountMinor: toMinor(price, currency), currency,
        subscriptionId: sub.id, providerPayload: { subscriptionRef: sub.providerRef },
      },
    });
    logger.info({ paymentId: payment.id, subscriptionId: sub.id, workspaceId: sub.workspaceId, plan: sub.planCode }, 'renewal charge recorded');
    return payment;
  }

  // ----------------------------------------------------------- subscription

  async subscription(workspaceId: string) {
    const sub = await this.currentSubscription(workspaceId);
    return sub ? this.subscriptionView(sub) : null;
  }

  /** Stop at the end of the paid period. Credits already granted stay. */
  async cancelSubscription(actor: Actor, workspaceId: string, req: Request) {
    this.assertBuyer(actor, workspaceId);
    const sub = await this.currentSubscription(workspaceId);
    if (!sub) throw new NotFoundError('subscription');
    if (sub.cancelAtPeriodEnd) return this.subscriptionView(sub);
    const gateway = this.gateways.get(sub.provider);
    if (gateway && sub.providerRef) {
      let ref = sub.providerRef;
      // Flutterwave's plan id is shared by every subscriber; the cancel needs the per-customer subscription id.
      if (gateway instanceof FlutterwaveGateway && sub.customerRef) ref = (await gateway.findSubscriptionId(sub.customerRef, sub.providerRef)) ?? ref;
      try { await gateway.cancelSubscription(ref, true); }
      catch (e) {
        logger.error({ err: e, subscriptionId: sub.id, provider: sub.provider }, 'gateway refused the cancellation');
        throw new ConflictError('The payment provider did not accept the cancellation. Try again, or contact support.');
      }
    }
    const updated = await this.db.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true, cancelledAt: new Date() } });
    authLog('billing.cancel', 'succeeded', { userId: actor.userId, workspaceId, subscriptionId: sub.id, provider: sub.provider }, req);
    return this.subscriptionView(updated);
  }

  // --------------------------------------------------------------- history

  async payments(workspaceId: string, q: PaymentsQueryDto) {
    const take = q.take ?? 30;
    const rows = await this.db.payment.findMany({
      where: { workspaceId, status: { not: 'PENDING' } }, orderBy: { createdAt: 'desc' }, take,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return { rows: rows.map((p) => this.paymentView(p)), nextCursor: rows.length === take ? (rows[rows.length - 1]?.id ?? null) : null };
  }

  async payment(workspaceId: string, id: string) {
    const p = await this.db.payment.findFirst({ where: { id, workspaceId } });
    if (!p) throw new NotFoundError('payment');
    return this.paymentView(p);
  }

  // ----------------------------------------------------------------- private

  private assertBuyer(actor: Actor, workspaceId: string): void {
    const role = actor.workspaceRoles.get(workspaceId);
    if (!role || !BUYERS.has(role)) throw new ForbiddenError('Only the owner, an admin or the billing contact can buy credits.');
  }

  private async priceItem(dto: CheckoutDto, currency: string, provider: PaymentProvider): Promise<CheckoutItem> {
    if (dto.kind === 'pack') {
      const pack = await this.db.creditPack.findFirst({ where: { code: dto.code, active: true } });
      if (!pack) throw new NotFoundError('credit pack');
      const price = priceIn(pack.priceByMarket, currency);
      if (price === null) throw new ValidationError({ code: `${pack.code} is not priced in ${currency} yet.` });
      return { kind: 'pack', code: pack.code, credits: pack.credits, amountMinor: toMinor(price, currency), currency, providerRef: refFor(pack.providerRefs, provider, 'once'), label: `${pack.credits} AnyStudio credits` };
    }
    const plan = await this.db.plan.findFirst({ where: { code: dto.code, active: true } });
    if (!plan) throw new NotFoundError('plan');
    const interval: Interval = dto.interval ?? 'month';
    const by = interval === 'year' ? plan.yearlyPriceByMarket : plan.priceByMarket;
    const price = priceIn(by, currency);
    if (price === null || price <= 0) throw new ValidationError({ interval: `${plan.code} cannot be billed ${interval === 'year' ? 'yearly' : 'monthly'} in ${currency}.` });
    return { kind: 'plan', code: plan.code, credits: plan.credits, interval, amountMinor: toMinor(price, currency), currency, providerRef: refFor(plan.providerRefs, provider, interval), label: `AnyStudio ${plan.code} plan, ${interval === 'year' ? 'yearly' : 'monthly'}` };
  }

  private async workspace(id: string) {
    const ws = await this.db.workspace.findFirst({ where: { id, deletedAt: null }, select: { id: true, currency: true, type: true } });
    if (!ws) throw new NotFoundError('workspace');
    return ws;
  }

  private currentSubscription(workspaceId: string) {
    return this.db.subscription.findFirst({ where: { workspaceId, status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } });
  }

  private subscriptionView(s: Subscription) {
    return { id: s.id, planCode: s.planCode, interval: s.interval, status: s.status, provider: s.provider, currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, cancelledAt: s.cancelledAt };
  }

  private paymentView(p: Payment) {
    return { id: p.id, reference: p.reference, provider: p.provider, kind: p.kind, status: p.status, itemCode: p.itemCode, interval: p.interval, credits: p.credits, amountMinor: p.amountMinor, currency: p.currency, checkoutUrl: p.status === 'PENDING' ? p.checkoutUrl : null, failureReason: p.failureReason, refundedAt: p.refundedAt, createdAt: p.createdAt, updatedAt: p.updatedAt };
  }
}

/** A price in `currency`, or null when the row has no tier for it. Never converted. */
export function priceIn(priceByMarket: unknown, currency: string): number | null {
  const by = (priceByMarket ?? {}) as Record<string, unknown>;
  const v = by[currency.toUpperCase()];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function refFor(refs: unknown, provider: PaymentProvider, key: string): string | number | undefined {
  if (provider === 'STUB') return 'stub';
  const r = (refs ?? {}) as Refs;
  const v = r[provider.toLowerCase()]?.[key];
  return typeof v === 'string' || typeof v === 'number' ? v : undefined;
}

function hasRef(refs: unknown, provider: PaymentProvider | null, key: string): boolean {
  return provider !== null && refFor(refs, provider, key) !== undefined;
}

export type { Plan, CreditPack };
