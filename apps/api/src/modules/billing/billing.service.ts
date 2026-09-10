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
import {
  Prisma,
  PrismaClient,
  type Payment,
  type PaymentProvider,
  type Plan,
  type CreditPack,
  type Subscription,
  type WebhookReceipt,
  type RefundRequest,
} from '@prisma/client';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { ProviderError } from '@anystudio/shared';
import { ConflictError, ForbiddenError, InsufficientCreditsError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { authLog } from '../auth/auth.log';
import { AuthService } from '../auth/auth.service';
import { NotificationService } from '../notification/notification.service';
import { Mailer } from '../../utils/mail-service';
import { refundDecided, refundRequested } from '../../assets/email-templates';
import { money } from '../usage-billing/usage-billing.service';
import { assertStaffMutation, type Actor } from '../auth/policy';
import { LedgerService } from '../ledger/ledger.service';
import { UsageBillingService } from '../usage-billing/usage-billing.service';
import { GatewayRegistry } from './gateways/gateway.registry';
import {
  toMinor,
  type CheckoutItem,
  type CheckoutSession,
  type Gateway,
  type Interval,
  type ParsedWebhook,
  type RefundVerification,
  type Verification,
  type WebhookIntent,
} from './billing.types';
import type { CheckoutDto, PaymentsQueryDto, RefundRequestDto, RefundsQueryDto } from './billing.dto';

type Refs = Record<string, Record<string, string | number> | undefined>;
type RefundCycleContext = { requestId: string; refundCycle: number };

const BUYERS = new Set(['OWNER', 'ADMIN', 'BILLING']);
/** A purchase can be asked back this long after it was made, if the credits are untouched. */
export const REFUND_WINDOW_DAYS = 14;
/** A process that dies while handling a webhook must not hold the event forever. */
const WEBHOOK_PROCESSING_TIMEOUT_MS = 5 * 60_000;
const WEBHOOK_RETRY_BASE_MS = 60_000;
const WEBHOOK_RETRY_MAX_MS = 6 * 60 * 60_000;
const WEBHOOK_MAX_ATTEMPTS = 20;
const WEBHOOK_DEFER_OUTCOMES = new Set(['no_payment', 'no_subscription', 'pending', 'refund_pending']);
const REFUND_RECHECK_MS = 15 * 60_000;
const REFUND_RETRY_MAX_MS = 6 * 60 * 60_000;
const REFUND_MAX_ATTEMPTS = 32;
const REFUND_RECONCILIATION_EXHAUSTED = 'Provider refund could not be confirmed automatically after the retry limit; operator review required.';
const CHECKOUT_RECONCILE_MAX_ATTEMPTS = 20;
/** Do not mistake a checkout that is still being created for an orphan. */
const CHECKOUT_ORPHAN_AFTER_MS = 5 * 60_000;

@Injectable()
export class BillingService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly gateways: GatewayRegistry,
    private readonly auth: AuthService,
    private readonly notifications: NotificationService,
    private readonly usageBilling: UsageBillingService,
    private readonly mailer: Mailer,
  ) {}

  // ----------------------------------------------------------------- config

  /** Paddle's client-side token is public by design (it opens checkouts, it cannot read anything). The API key never leaves the server. */
  clientConfig() {
    const token = process.env.PADDLE_CLIENT_TOKEN;
    return {
      paddle: token ? { clientToken: token, environment: process.env.PADDLE_ENV === 'live' ? 'production' : 'sandbox' } : null,
      gateways: (['FLUTTERWAVE', 'PADDLE', 'STUB'] as const).filter((p) => this.gateways.has(p)),
    };
  }

  // -------------------------------------------------------------- catalogue

  /** Packs and plans priced in the workspace's currency, and what it is on today. */
  async catalogue(workspaceId: string) {
    const ws = await this.workspace(workspaceId);
    const currency = ws.currency.toUpperCase();
    let provider: PaymentProvider | null = null;
    let gateway: Gateway | null = null;
    try {
      gateway = this.gateways.forCurrency(currency);
      provider = gateway.provider;
    } catch {
      provider = null;
    }
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
      packs: packs.map((p) => ({
        code: p.code,
        credits: p.credits,
        price: price(p.priceByMarket),
        canBuy:
          gateway !== null &&
          price(p.priceByMarket) !== null &&
          gateway.checkoutAvailable({ kind: 'pack', providerRef: refFor(p.providerRefs, gateway.provider, 'once') }),
      })),
      plans: plans.map((p) => ({
        code: p.code,
        credits: p.credits,
        month: {
          price: price(p.priceByMarket),
          canBuy:
            gateway !== null &&
            price(p.priceByMarket) !== null &&
            gateway.checkoutAvailable({ kind: 'plan', providerRef: refFor(p.providerRefs, gateway.provider, 'month') }),
        },
        year: p.yearlyPriceByMarket
          ? {
              price: price(p.yearlyPriceByMarket),
              canBuy:
                gateway !== null &&
                price(p.yearlyPriceByMarket) !== null &&
                gateway.checkoutAvailable({ kind: 'plan', providerRef: refFor(p.providerRefs, gateway.provider, 'year') }),
            }
          : null,
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
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { email: true, name: true, phone: true, deleteRequestedAt: true },
    });
    if (user.deleteRequestedAt) throw new ConflictError('Keep your account before opening a new payment checkout.');
    const ws = await this.workspace(workspaceId);
    const currency = ws.currency.toUpperCase();
    const gateway = this.gateways.forCurrency(currency);
    const item = await this.priceItem(dto, currency, gateway.provider);
    const reference = `as_${item.kind}_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
    const paymentData: Prisma.PaymentUncheckedCreateInput = {
      workspaceId,
      userId: actor.userId,
      provider: gateway.provider,
      kind: item.kind === 'pack' ? 'PACK' : 'SUBSCRIPTION',
      reference,
      itemCode: item.code,
      interval: item.interval,
      credits: item.credits,
      amountMinor: item.amountMinor,
      currency: item.currency,
      providerPayload: checkoutProviderContext(item),
    };
    let payment: Payment;
    if (item.kind === 'plan') {
      const claimed = await this.db.$transaction(async (tx) => {
        // The workspace row is our per-customer checkout mutex. A plain
        // find-then-create still permits two browser tabs to create two
        // provider subscriptions before either Payment becomes visible.
        const [lockedWorkspace] = await tx.$queryRaw<Array<{ id: string; currency: string }>>`
          SELECT "id", "currency" FROM "workspaces" WHERE "id" = CAST(${workspaceId} AS uuid) FOR UPDATE
        `;
        if (!lockedWorkspace) throw new NotFoundError('workspace');
        if (lockedWorkspace.currency.toUpperCase() !== currency) {
          throw new ConflictError('The workspace currency changed while checkout was opening. Refresh billing and try again.');
        }
        const current = await tx.subscription.findFirst({
          where: { workspaceId, status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } },
          orderBy: { createdAt: 'desc' },
        });
        if (current)
          throw new ConflictError(
            current.cancelAtPeriodEnd
              ? `${current.planCode} stays active until its paid period ends. Choose the next plan after that date, or buy a pack now.`
              : `This workspace is already on ${current.planCode}. Cancel it first, or buy a pack instead.`,
          );

        const pending = await tx.payment.findFirst({
          where: { workspaceId, kind: 'SUBSCRIPTION', status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
        });
        if (pending) {
          const sameCheckout = pending.itemCode === item.code && pending.interval === item.interval && pending.currency === item.currency;
          if (sameCheckout && pending.checkoutUrl) return { payment: pending, reused: true };
          throw new ConflictError(
            sameCheckout
              ? 'A subscription checkout is already being reconciled. Use its payment page or contact support instead of opening another.'
              : `A checkout for ${pending.itemCode} is already pending. Finish that checkout or contact support before choosing another plan.`,
          );
        }
        return { payment: await tx.payment.create({ data: paymentData }), reused: false };
      });
      payment = claimed.payment;
      if (claimed.reused && payment.checkoutUrl)
        return {
          paymentId: payment.id,
          reference: payment.reference,
          provider: payment.provider,
          url: payment.checkoutUrl,
          credits: payment.credits,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
        };
    } else {
      payment = await this.db.payment.create({ data: paymentData });
    }
    const origin = this.auth.publicOrigin(req);
    let session;
    try {
      session = await gateway.createCheckout({
        payment,
        item,
        customer: user,
        returnUrl: `${origin}/billing/return?ref=${encodeURIComponent(reference)}&paymentId=${encodeURIComponent(payment.id)}`,
        appOrigin: origin,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const rejected = definitiveCheckoutRejection(e);
      if (rejected) await this.failUncreatedCheckout(payment, `checkout rejected: ${detail}`);
      else
        await this.db.payment.update({
          where: { id: payment.id },
          // The provider may have accepted the POST before our connection died.
          // Keep the row recoverable: maintenance looks it up by our immutable
          // merchant reference and will settle or release it only from provider truth.
          data: {
            failureReason: `checkout setup uncertain: ${detail}`,
            providerPayload: checkoutRecoveryPayload(payment.providerPayload, 0, detail),
          },
        });
      logger.error({ err: e, paymentId: payment.id, provider: gateway.provider, item: item.code }, 'checkout creation failed');
      if (rejected) throw new ConflictError('The payment provider rejected this checkout. Nothing was charged; review the billing details and try again.');
      throw new ConflictError('The payment page could not be opened. This attempt is being reconciled; do not open another plan checkout yet.');
    }
    await this.persistCheckoutSession(payment, session);
    authLog(
      'billing.checkout',
      'succeeded',
      {
        userId: actor.userId,
        workspaceId,
        paymentId: payment.id,
        provider: gateway.provider,
        item: item.code,
        interval: item.interval,
        amountMinor: item.amountMinor,
        currency,
      },
      req,
    );
    return { paymentId: payment.id, reference, provider: gateway.provider, url: session.url, credits: item.credits, amountMinor: item.amountMinor, currency };
  }

  /**
   * An invoice paid online. The row is priced from the invoice, never the
   * client; the gateway sees a one-off charge; settle() marks the invoice
   * paid and returns its credits to the line. A pending checkout for the
   * same invoice is reused so a person who closed the tab does not pay twice.
   */
  async payInvoice(actor: Actor, workspaceId: string, invoiceId: string, req: Request) {
    this.assertBuyer(actor, workspaceId);
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { email: true, name: true, phone: true, deleteRequestedAt: true },
    });
    if (user.deleteRequestedAt) throw new ConflictError('Keep your account before opening a new payment checkout.');
    const invoice = await this.db.invoice.findFirst({ where: { id: invoiceId, workspaceId } });
    if (!invoice) throw new NotFoundError('invoice');
    if (invoice.status === 'PAID') throw new ConflictError(`Invoice ${invoice.number} is already paid.`);
    if (invoice.status === 'VOID') throw new ConflictError(`Invoice ${invoice.number} was voided.`);
    if (invoice.totalMinor <= 0) throw new ConflictError('There is nothing to pay on this invoice.');
    const currency = invoice.currency.toUpperCase();
    const gateway = this.gateways.forCurrency(currency);
    const reference = `as_inv_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
    const claimed = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "invoices" WHERE "id" = CAST(${invoiceId} AS uuid) FOR UPDATE
      `;
      const lockedInvoice = await tx.invoice.findFirst({ where: { id: invoiceId, workspaceId } });
      if (!lockedInvoice) throw new NotFoundError('invoice');
      if (lockedInvoice.status === 'PAID') throw new ConflictError(`Invoice ${lockedInvoice.number} is already paid.`);
      if (lockedInvoice.status === 'VOID') throw new ConflictError(`Invoice ${lockedInvoice.number} was voided.`);
      if (lockedInvoice.totalMinor <= 0) throw new ConflictError('There is nothing to pay on this invoice.');
      if (lockedInvoice.currency.toUpperCase() !== currency) {
        throw new ConflictError('The invoice currency changed while checkout was opening. Refresh the invoice and try again.');
      }

      const item: CheckoutItem = {
        kind: 'invoice',
        code: lockedInvoice.number,
        credits: lockedInvoice.credits,
        amountMinor: lockedInvoice.totalMinor,
        currency,
        label: `AnyStudio invoice ${lockedInvoice.number}`,
      };
      if (lockedInvoice.paymentId) {
        const bound = await tx.payment.findUnique({ where: { id: lockedInvoice.paymentId } });
        if (!bound) throw new ConflictError(`Invoice ${lockedInvoice.number} has a missing payment reservation; contact support.`);
        if (bound.status === 'PENDING' && bound.checkoutUrl) return { payment: bound, item, reused: true };
        if (bound.status === 'PENDING') {
          // A timed-out provider POST is ambiguous. Age is not proof that the
          // hosted transaction cannot still take money, so never create a
          // second checkout until provider verification makes this one final.
          throw new ConflictError('This invoice payment is being reconciled. Contact support if its payment page does not appear.');
        }
        if (bound.status !== 'FAILED') {
          throw new ConflictError(`Invoice ${lockedInvoice.number} already has a ${bound.status.toLowerCase()} payment transaction.`);
        }
      }
      const payment = await tx.payment.create({
        data: {
          workspaceId,
          userId: actor.userId,
          provider: gateway.provider,
          kind: 'INVOICE',
          reference,
          itemCode: lockedInvoice.number,
          credits: lockedInvoice.credits,
          amountMinor: lockedInvoice.totalMinor,
          currency,
          providerPayload: checkoutProviderContext(item),
        },
      });
      await tx.invoice.update({ where: { id: lockedInvoice.id }, data: { paymentId: payment.id } });
      return { payment, item, reused: false };
    });
    const { payment, item } = claimed;
    if (claimed.reused && payment.checkoutUrl) {
      return {
        paymentId: payment.id,
        reference: payment.reference,
        provider: payment.provider,
        url: payment.checkoutUrl,
        credits: payment.credits,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      };
    }
    const origin = this.auth.publicOrigin(req);
    let session;
    try {
      session = await gateway.createCheckout({
        payment,
        item,
        customer: user,
        returnUrl: `${origin}/billing/return?ref=${encodeURIComponent(payment.reference)}&paymentId=${encodeURIComponent(payment.id)}`,
        appOrigin: origin,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const rejected = definitiveCheckoutRejection(e);
      if (rejected) await this.failUncreatedCheckout(payment, `checkout rejected: ${detail}`);
      else
        await this.db.payment.update({
          where: { id: payment.id },
          data: {
            failureReason: `checkout setup uncertain: ${detail}`,
            providerPayload: checkoutRecoveryPayload(payment.providerPayload, 0, detail),
          },
        });
      logger.error({ err: e, paymentId: payment.id, provider: gateway.provider, invoice: invoice.number }, 'invoice checkout creation failed');
      if (rejected) throw new ConflictError('The payment provider rejected this checkout. Nothing was charged; review the invoice and try again.');
      throw new ConflictError('The payment page could not be opened. This attempt is being reconciled; do not open another checkout yet.');
    }
    await this.persistCheckoutSession(payment, session);
    authLog(
      'billing.checkout',
      'succeeded',
      { userId: actor.userId, workspaceId, paymentId: payment.id, provider: gateway.provider, item: invoice.number, amountMinor: invoice.totalMinor, currency },
      req,
    );
    return {
      paymentId: payment.id,
      reference: payment.reference,
      provider: gateway.provider,
      url: session.url,
      credits: payment.credits,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    };
  }

  // ------------------------------------------------------------- settlement

  /** The return page asking "did it go through?". Verifies with the gateway and settles. */
  async verifyPayment(workspaceId: string, paymentId: string, hint: { providerRef?: string }, req?: Request) {
    const payment = await this.db.payment.findFirst({ where: { id: paymentId, workspaceId } });
    if (!payment) throw new NotFoundError('payment');
    if (payment.status === 'SUCCEEDED' || payment.status === 'REFUNDED' || payment.status === 'NEEDS_REVIEW') return this.paymentView(payment);
    const gateway = this.gateways.get(payment.provider);
    if (!gateway) throw new NotFoundError('payment gateway');
    const v = await gateway.verify(payment, hint.providerRef ? { providerRef: hint.providerRef } : undefined);
    const settled = await this.settle(payment, v, 'return');
    if (req)
      authLog(
        'billing.verify',
        settled.status === 'SUCCEEDED' ? 'succeeded' : settled.status === 'FAILED' ? 'refused' : 'succeeded',
        { paymentId, status: settled.status, via: 'return' },
        req,
      );
    return this.paymentView(settled);
  }

  /**
   * Apply a verification to a row. Idempotent: a SUCCEEDED row is returned
   * untouched, and the ledger key makes the grant itself single-shot even
   * if two verifications race past the status read.
   */
  private async settle(payment: Payment, v: Verification, via: 'webhook' | 'return', transaction?: Prisma.TransactionClient): Promise<Payment> {
    let invoiceCompletionId: string | undefined;
    let notifyCredits = false;
    const apply = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "payments" WHERE "id" = CAST(${payment.id} AS uuid) FOR UPDATE
      `;
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "refund_requests" WHERE "paymentId" = CAST(${payment.id} AS uuid) FOR UPDATE
      `;
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      // Older releases could consume an adjustment before the corresponding
      // charge event. They left an unfulfilled Payment in NEEDS_REVIEW. That
      // is not a terminal settlement state: once the provider independently
      // confirms the charge, settle it and let the adjustment be recomputed
      // against the newly-created immutable funding in the same transaction.
      if (fresh.status === 'SUCCEEDED' || fresh.status === 'REFUNDED' || (fresh.status === 'NEEDS_REVIEW' && !isRecoverableEarlyAdjustment(fresh)))
        return fresh;

      // The customer never received this hosted page, so maintenance released
      // its local reservation. A contradictory late charge must be returned,
      // not granted on top of whatever checkout they opened next.
      if (fresh.status === 'FAILED' && fresh.failureReason?.startsWith('checkout abandoned:') && v.ok) {
        return this.queueAutomaticRefund(tx, fresh, v, 'Provider charged a checkout whose payment page was never delivered');
      }

      if (!v.ok) {
        if (v.state === 'failed') {
          logger.warn({ paymentId: fresh.id, provider: fresh.provider, reason: v.reason, via }, 'payment failed');
          const failed = await tx.payment.update({
            where: { id: fresh.id },
            data: {
              status: 'FAILED',
              failureReason: `gateway reported failure: ${v.reason}`,
              providerPayload: verifiedProviderPayload(fresh.providerPayload, v.raw),
            },
          });
          // Renewal failure and subscription state are one serial operation.
          // In particular, a failed transaction must not commit and then
          // update the Subscription in a second transaction: a newer success
          // could land in that gap and be overwritten back to PAST_DUE. Take
          // these locks only on the no-ledger failure path so the global lock
          // order for successful settlements remains wallet -> subscription.
          let lockedRenewalSubscription: Subscription | null = null;
          if (fresh.kind === 'RENEWAL' && fresh.subscriptionId) {
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "workspaces" WHERE "id" = CAST(${fresh.workspaceId} AS uuid) FOR UPDATE
            `;
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "subscriptions" WHERE "id" = CAST(${fresh.subscriptionId} AS uuid) FOR UPDATE
            `;
            lockedRenewalSubscription = await tx.subscription.findUnique({ where: { id: fresh.subscriptionId } });
          }
          if (lockedRenewalSubscription && ['ACTIVE', 'PAUSED'].includes(lockedRenewalSubscription.status)) {
            const successfulRenewals = await tx.payment.findMany({
              where: {
                subscriptionId: lockedRenewalSubscription.id,
                kind: 'RENEWAL',
                status: 'SUCCEEDED',
                id: { not: fresh.id },
              },
              select: { id: true, createdAt: true, updatedAt: true, providerPayload: true },
            });
            const authority = renewalFailureAuthority(fresh, v.raw, lockedRenewalSubscription, successfulRenewals);
            if (authority.current) {
              await tx.subscription.updateMany({
                where: { id: lockedRenewalSubscription.id, status: { in: ['ACTIVE', 'PAUSED'] } },
                data: { status: 'PAST_DUE' },
              });
            } else {
              logger.info(
                {
                  paymentId: fresh.id,
                  subscriptionId: lockedRenewalSubscription.id,
                  reason: authority.reason,
                },
                'stale or ambiguous failed renewal left the current subscription unchanged',
              );
            }
          }
          return failed;
        }
        logger.info({ paymentId: fresh.id, provider: fresh.provider, reason: v.reason, via }, 'payment still pending');
        return fresh;
      }

      const owned = await tx.payment.findFirst({
        where: { provider: fresh.provider, providerRef: v.providerRef, id: { not: fresh.id } },
        select: { id: true },
      });
      if (owned) {
        return tx.payment.update({
          where: { id: fresh.id },
          data: {
            status: 'NEEDS_REVIEW',
            failureReason: `provider transaction ${v.providerRef} is already attached to payment ${owned.id}`,
            providerPayload: verifiedProviderPayload(fresh.providerPayload, v.raw),
          },
        });
      }

      // The row is the contract. Flutterwave charges the number we sent, so it
      // must match; Paddle prices in its own currency with its own tax, so we
      // record what it charged — the price id was checked at checkout.
      if (fresh.provider !== 'PADDLE') {
        const mismatch =
          v.currency !== fresh.currency
            ? `currency ${v.currency} != ${fresh.currency}`
            : v.amountMinor !== fresh.amountMinor
              ? `amount ${v.amountMinor} != ${fresh.amountMinor}`
              : null;
        if (mismatch) {
          logger.error(
            { paymentId: fresh.id, provider: fresh.provider, providerRef: v.providerRef, mismatch, via },
            'PAYMENT MISMATCH: charged amount does not match the priced row; automatic refund queued',
          );
          return this.queueAutomaticRefund(tx, fresh, v, `Payment mismatch: ${mismatch}`);
        }
      }

      if (fresh.kind === 'INVOICE') {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "invoices" WHERE "number" = ${fresh.itemCode} FOR UPDATE
        `;
        const invoice = await tx.invoice.findUnique({ where: { number: fresh.itemCode } });
        if (!invoice) {
          logger.error({ paymentId: fresh.id, invoice: fresh.itemCode }, 'PAYMENT FOR UNKNOWN INVOICE: automatic refund queued');
          return this.queueAutomaticRefund(tx, fresh, v, `Invoice ${fresh.itemCode} does not exist`);
        }
        if (invoice.workspaceId !== fresh.workspaceId) {
          return this.queueAutomaticRefund(tx, fresh, v, `Invoice ${fresh.itemCode} belongs to another workspace`);
        }
        const matchesLegacyProviderSettlement =
          invoice.status === 'PAID' && invoice.paymentId === null && invoice.paidVia === fresh.provider && invoice.paidReference === v.providerRef;
        if (
          invoice.status === 'PAID' &&
          !matchesLegacyProviderSettlement &&
          (invoice.paymentId !== fresh.id || invoice.paidVia !== fresh.provider || invoice.paidReference !== v.providerRef)
        ) {
          return this.queueAutomaticRefund(tx, fresh, v, `Invoice ${fresh.itemCode} was already paid${invoice.paidVia ? ` via ${invoice.paidVia}` : ''}`);
        }
        if (invoice.status === 'VOID' || invoice.status === 'REFUNDED' || invoice.status === 'DISPUTED') {
          return this.queueAutomaticRefund(tx, fresh, v, `Invoice ${fresh.itemCode} is ${invoice.status.toLowerCase()}`);
        }
        if (invoice.paymentId && invoice.paymentId !== fresh.id) {
          return this.queueAutomaticRefund(tx, fresh, v, `Invoice ${fresh.itemCode} was already bound to payment ${invoice.paymentId}`);
        }
        if (!invoice.paymentId) await tx.invoice.update({ where: { id: invoice.id }, data: { paymentId: fresh.id } });
        const paid = await this.usageBilling.settleInvoice(invoice.id, fresh.provider, v.providerRef, fresh.id, tx);
        if (invoice.status !== 'PAID') invoiceCompletionId = invoice.id;
        return tx.payment.update({
          where: { id: fresh.id },
          data: {
            status: 'SUCCEEDED',
            providerRef: v.providerRef,
            amountMinor: fresh.provider === 'PADDLE' && v.amountMinor > 0 ? v.amountMinor : fresh.amountMinor,
            currency: fresh.provider === 'PADDLE' ? v.currency : fresh.currency,
            providerPayload: verifiedProviderPayload(fresh.providerPayload, v.raw),
            ledgerEntryId: paid.ledgerEntryId,
            failureReason: null,
          },
        });
      }

      if (fresh.kind === 'RENEWAL' && fresh.subscriptionId) {
        const subscription = await tx.subscription.findUnique({ where: { id: fresh.subscriptionId } });
        if (!subscription || subscription.status === 'CANCELLED' || subscription.providerCancelPending) {
          return this.queueAutomaticRefund(tx, fresh, v, 'Provider charged a subscription that is cancelled locally');
        }
      }

      if (fresh.kind === 'SUBSCRIPTION') {
        // A checkout that failed locally can still settle late. Never let it
        // replace a newer active plan: lock the workspace, prove ownership by
        // the exact provider subscription id, or contain the old charge.
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "workspaces" WHERE "id" = CAST(${fresh.workspaceId} AS uuid) FOR UPDATE
        `;
        const active = await tx.subscription.findFirst({
          where: { workspaceId: fresh.workspaceId, status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } },
          orderBy: { createdAt: 'desc' },
        });
        const ownsActive = Boolean(
          active &&
          (fresh.subscriptionId === active.id || (v.subscriptionRef && active.provider === fresh.provider && active.providerRef === v.subscriptionRef)),
        );
        if (active && !ownsActive) {
          return this.queueAutomaticRefund(tx, fresh, v, `A newer active subscription ${active.id} already owns this workspace`);
        }
      }

      const wallet = await tx.wallet.findUniqueOrThrow({ where: { workspaceId: fresh.workspaceId }, select: { id: true } });
      const entry = await this.ledger.purchase(
        {
          walletId: wallet.id,
          amount: fresh.credits,
          idempotencyKey: `payment:${fresh.id}`,
          referenceId: fresh.id,
          reason:
            fresh.kind === 'PACK' ? `Credit pack ${fresh.itemCode}` : fresh.kind === 'RENEWAL' ? `${fresh.itemCode} plan renewed` : `${fresh.itemCode} plan`,
        },
        tx,
      );

      let subscriptionId: string | null = fresh.subscriptionId;
      if (fresh.kind !== 'PACK') {
        const sub = await this.upsertSubscription(fresh, v, tx);
        subscriptionId = sub.id;
      }
      notifyCredits = true;
      return tx.payment.update({
        where: { id: fresh.id },
        data: {
          status: 'SUCCEEDED',
          providerRef: v.providerRef,
          amountMinor: fresh.provider === 'PADDLE' && v.amountMinor > 0 ? v.amountMinor : fresh.amountMinor,
          currency: fresh.provider === 'PADDLE' ? v.currency : fresh.currency,
          providerPayload: verifiedSuccessfulProviderPayload(fresh.providerPayload, v),
          ledgerEntryId: entry.id,
          subscriptionId,
          failureReason: null,
        },
      });
    };
    const updated = transaction ? await apply(transaction) : await this.db.$transaction(apply);

    // A caller composing settlement with another financial transition owns
    // the outer transaction and its post-commit effects. Never emit success
    // notifications for state that has not committed yet.
    if (transaction) return updated;

    if (invoiceCompletionId) {
      await this.usageBilling
        .completeInvoiceSettlement(invoiceCompletionId)
        .catch((err: unknown) => logger.error({ err, invoiceId: invoiceCompletionId, paymentId: updated.id }, 'invoice settlement follow-up failed'));
      logger.info(
        {
          paymentId: updated.id,
          workspaceId: updated.workspaceId,
          provider: updated.provider,
          invoice: updated.itemCode,
          amountMinor: updated.amountMinor,
          currency: updated.currency,
          via,
        },
        'invoice payment settled',
      );
    }
    if (v.ok && updated.kind !== 'INVOICE')
      logger.info(
        {
          paymentId: updated.id,
          workspaceId: updated.workspaceId,
          provider: updated.provider,
          providerRef: v.providerRef,
          credits: updated.credits,
          amountMinor: updated.amountMinor,
          currency: updated.currency,
          kind: updated.kind,
          via,
          ledgerEntryId: updated.ledgerEntryId,
        },
        updated.status === 'NEEDS_REVIEW' ? 'payment requires billing review; fulfilment withheld' : 'payment settled; credits granted',
      );
    if (notifyCredits && updated.userId)
      void this.notifications.notify(updated.userId, {
        workspaceId: updated.workspaceId,
        kind: 'CREDITS',
        title: `${updated.credits.toLocaleString()} credits added`,
        body:
          updated.kind === 'RENEWAL'
            ? 'Your plan renewed.'
            : updated.kind === 'SUBSCRIPTION'
              ? 'Your plan is active. The credits are in your balance.'
              : 'Your top-up cleared. The credits are in your balance.',
        href: '/billing',
        refId: updated.id,
      });
    return updated;
  }

  private async queueSubscriptionCancellation(tx: Prisma.TransactionClient, payment: Payment, v: Extract<Verification, { ok: true }>): Promise<string | null> {
    const now = new Date();
    let cancellationSubscriptionId = payment.subscriptionId;
    if (payment.kind === 'SUBSCRIPTION' || payment.kind === 'RENEWAL') {
      // Refunding a subscription charge does not stop the provider from
      // billing it next month. Persist cancellation as an outbox command in
      // this same transaction so a crash can delay, but never lose, the stop.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "workspaces" WHERE "id" = CAST(${payment.workspaceId} AS uuid) FOR UPDATE
      `;
      let subscription = payment.subscriptionId
        ? await tx.subscription.findUnique({ where: { id: payment.subscriptionId } })
        : v.subscriptionRef
          ? await tx.subscription.findFirst({ where: { provider: payment.provider, providerRef: v.subscriptionRef } })
          : null;
      if (subscription) {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "subscriptions" WHERE "id" = CAST(${subscription.id} AS uuid) FOR UPDATE
        `;
        subscription = await tx.subscription.findUnique({ where: { id: subscription.id } });
      }
      if (subscription) {
        const cancelled = await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            status: 'CANCELLED',
            cancelAtPeriodEnd: false,
            cancelledAt: subscription.cancelledAt ?? now,
            providerCancelPending: true,
            providerCancelAttempts: 0,
            providerCancelNextAt: now,
            providerCancelError: null,
          },
        });
        cancellationSubscriptionId = cancelled.id;
      } else if (v.subscriptionRef) {
        const timing = renewalTiming(v.raw);
        const cancelled = await tx.subscription.create({
          data: {
            workspaceId: payment.workspaceId,
            provider: payment.provider,
            providerRef: v.subscriptionRef,
            catalogueRef: providerContext(payment.providerPayload).catalogueRef ?? null,
            planCode: payment.itemCode,
            interval: payment.interval ?? 'month',
            status: 'CANCELLED',
            currentPeriodStart: v.periodStart ?? timing.periodStart,
            currentPeriodEnd: v.periodEnd ?? timing.periodEnd,
            cancelAtPeriodEnd: false,
            cancelledAt: now,
            customerRef: v.customerRef ?? null,
            providerUpdatedAt: latestDate([timing.occurredAt, v.periodStart ?? null]),
            providerCancelPending: true,
            providerCancelAttempts: 0,
            providerCancelNextAt: now,
          },
        });
        cancellationSubscriptionId = cancelled.id;
      } else {
        logger.error(
          { paymentId: payment.id, provider: payment.provider, subscriptionRef: v.subscriptionRef, kind: payment.kind },
          'SUBSCRIPTION REFUND NEEDS REVIEW: provider subscription could not be queued for cancellation',
        );
      }
    }
    return cancellationSubscriptionId;
  }

  private async queueAutomaticRefund(tx: Prisma.TransactionClient, payment: Payment, v: Extract<Verification, { ok: true }>, reason: string): Promise<Payment> {
    const now = new Date();
    const cancellationSubscriptionId = await this.queueSubscriptionCancellation(tx, payment, v);
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'NEEDS_REVIEW',
        providerRef: v.providerRef,
        amountMinor: v.amountMinor > 0 ? v.amountMinor : payment.amountMinor,
        currency: v.currency || payment.currency,
        providerPayload: automaticRefundProviderPayload(payment.providerPayload, v.raw, reason),
        failureReason: `${reason}; automatic full refund queued`,
        subscriptionId: cancellationSubscriptionId,
      },
    });
    await tx.refundRequest.upsert({
      where: { paymentId: payment.id },
      create: {
        paymentId: payment.id,
        workspaceId: payment.workspaceId,
        requestedById: null,
        reason: `Automatic recovery: ${reason}`,
        status: 'PROCESSING',
        balanceAtRequest: 0,
        decidedAt: now,
        decisionNote: 'Automatic full refund queued before any credits were granted.',
        processingAt: null,
        nextAttemptAt: now,
        refundCycle: 1,
      },
      update: {
        requestedById: null,
        reason: `Automatic recovery: ${reason}`,
        status: 'PROCESSING',
        decidedAt: now,
        decidedById: null,
        decisionNote: 'Automatic full refund queued before any credits were granted.',
        gatewayRef: null,
        processingAt: null,
        nextAttemptAt: now,
        attempts: 0,
        refundCycle: { increment: 1 },
        lastError: null,
      },
    });
    return updated;
  }

  private async upsertSubscription(payment: Payment, v: Extract<Verification, { ok: true }>, tx: Prisma.TransactionClient): Promise<Subscription> {
    // Webhook event types can race each other. Serialise subscription
    // creation on the workspace in addition to the partial unique index,
    // so both contenders converge on one row without a failed payment.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "workspaces" WHERE "id" = CAST(${payment.workspaceId} AS uuid) FOR UPDATE
    `;
    let existing = payment.subscriptionId
      ? await tx.subscription.findUnique({ where: { id: payment.subscriptionId } })
      : await tx.subscription.findFirst({
          where: { workspaceId: payment.workspaceId, status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } },
          orderBy: { createdAt: 'desc' },
        });
    if (existing) {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "subscriptions" WHERE "id" = CAST(${existing.id} AS uuid) FOR UPDATE
      `;
      existing = await tx.subscription.findUnique({ where: { id: existing.id } });
    }
    if (payment.kind === 'RENEWAL' && (!existing || existing.status === 'CANCELLED' || existing.providerCancelPending)) {
      // The earlier pre-ledger check can race a provider cancellation webhook.
      // Throwing rolls this transaction (including the provisional ledger
      // entry) back; a retry then takes settle()'s automatic-refund path.
      throw new Error('subscription became cancelled while its renewal was settling');
    }
    const successTiming = renewalTiming(v.raw);
    const successOccurredAt = successTiming.occurredAt;
    // A delayed renewal without explicit billing_period must be anchored to
    // the provider transaction time, never webhook receipt time. If neither
    // fact exists, preserve the current period and wait for subscription data.
    const fallbackAnchor = payment.kind === 'RENEWAL' ? successOccurredAt : (successOccurredAt ?? new Date());
    const periodEnd = v.periodEnd ?? (fallbackAnchor ? advanceBillingPeriod(fallbackAnchor, payment.interval) : (existing?.currentPeriodEnd ?? null));
    const periodAdvances = Boolean(periodEnd && (!existing?.currentPeriodEnd || periodEnd.getTime() > existing.currentPeriodEnd.getTime()));
    const periodStart =
      v.periodStart ??
      (payment.kind === 'RENEWAL' ? (successOccurredAt ?? existing?.currentPeriodEnd ?? existing?.currentPeriodStart) : (successOccurredAt ?? new Date()));
    const successAfterProviderStatus =
      !existing?.providerUpdatedAt ||
      Boolean(successOccurredAt && successOccurredAt.getTime() > existing.providerUpdatedAt.getTime()) ||
      Boolean(v.periodStart && v.periodStart.getTime() > existing.providerUpdatedAt.getTime());
    const status = !existing || existing.status === 'ACTIVE' || successAfterProviderStatus ? ('ACTIVE' as const) : existing.status;
    // The billing-period start is itself authoritative provider ordering data.
    // Persist it when it is newer so a delayed status event from between the
    // old provider timestamp and this paid period cannot regress ACTIVE.
    const providerUpdatedAt = latestDate([existing?.providerUpdatedAt ?? null, successOccurredAt, v.periodStart ?? null]);
    const data = {
      provider: payment.provider,
      providerRef: v.subscriptionRef ?? existing?.providerRef ?? null,
      catalogueRef: providerContext(payment.providerPayload).catalogueRef ?? existing?.catalogueRef ?? null,
      planCode: payment.itemCode,
      interval: payment.interval ?? 'month',
      // A delayed successful transaction may still grant previously-missing
      // credits, but it cannot overwrite a later authoritative PAST_DUE or
      // PAUSED subscription event.
      status,
      // Webhooks and manual return-page checks can settle older renewals
      // after a newer period. Grant the missing payment once, but never move
      // the subscription clock backwards.
      currentPeriodStart: periodAdvances ? periodStart : existing?.currentPeriodStart,
      currentPeriodEnd: periodAdvances ? periodEnd : existing?.currentPeriodEnd,
      customerRef: v.customerRef ?? existing?.customerRef ?? null,
      providerUpdatedAt,
      // A paid renewal may arrive after the customer scheduled cancellation.
      // It extends the paid period but must never silently resume future billing.
      cancelAtPeriodEnd: existing?.cancelAtPeriodEnd ?? false,
      cancelledAt: existing?.cancelledAt ?? null,
    };
    if (existing) return tx.subscription.update({ where: { id: existing.id }, data });
    return tx.subscription.create({ data: { workspaceId: payment.workspaceId, ...data } });
  }

  // --------------------------------------------------------------- webhooks

  /**
   * One entry point per gateway. Authenticates first, then records the verified
   * receipt before acting on the intent. Processing failures are recorded and
   * rethrown so the gateway
   * redelivers; that redelivery atomically reclaims an errored attempt. A
   * stale `processing` claim is also reclaimable after a process crash.
   */
  async handleWebhook(
    provider: PaymentProvider,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ status: string; outcome?: string }> {
    const gateway = this.gateways.get(provider);
    if (!gateway) {
      logger.error({ provider }, 'webhook for a gateway that is not configured');
      // Non-2xx makes the provider retry while configuration is repaired.
      throw new ConflictError(`${provider} webhook cannot be processed because its gateway is not configured.`);
    }
    const parsed = gateway.parseWebhook(rawBody, headers);
    // An invalid signature proves neither who sent the request nor that its
    // event id is genuine. Persisting attacker-chosen ids/payloads here creates
    // an unauthenticated, unbounded database-write endpoint and can also retain
    // arbitrary personal data. Valid deliveries are the durable audit trail.
    if (!parsed.signatureOk) {
      logger.warn({ provider, eventId: parsed.eventId, type: parsed.type }, 'webhook signature rejected');
      throw new ForbiddenError('Invalid webhook signature');
    }
    const payload = (parsed.body ?? { raw: rawBody.toString('utf8').slice(0, 4000) }) as Prisma.InputJsonValue;
    const attemptStartedAt = new Date();
    let receipt;
    try {
      receipt = await this.db.webhookReceipt.create({
        data: {
          provider,
          eventId: parsed.eventId,
          eventType: parsed.type,
          signatureOk: parsed.signatureOk,
          payload,
          attempts: 1,
          lastAttemptAt: attemptStartedAt,
          nextAttemptAt: null,
          processedAt: null,
          outcome: 'processing',
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.db.webhookReceipt.findUnique({ where: { provider_eventId: { provider, eventId: parsed.eventId } } });
        if (!existing) throw e;
        const staleProcessing =
          existing.outcome === 'processing' && (!existing.lastAttemptAt || existing.lastAttemptAt.getTime() <= Date.now() - WEBHOOK_PROCESSING_TIMEOUT_MS);
        const abandonedUnclaimed =
          existing.outcome === null && existing.processedAt === null && existing.receivedAt.getTime() <= Date.now() - WEBHOOK_PROCESSING_TIMEOUT_MS;
        const retryable = existing.outcome === 'error' || staleProcessing || abandonedUnclaimed || !existing.signatureOk;
        if (!retryable) {
          if (existing.outcome === 'processing') return { status: 'processing' };
          logger.info({ provider, eventId: parsed.eventId, type: parsed.type, outcome: existing.outcome }, 'webhook redelivered; already recorded');
          return { status: 'duplicate' };
        }
        const claimed = await this.db.webhookReceipt.updateMany({
          where: {
            id: existing.id,
            signatureOk: existing.signatureOk,
            outcome: existing.outcome,
            lastAttemptAt: existing.lastAttemptAt,
          },
          data: {
            eventType: parsed.type,
            signatureOk: true,
            payload,
            attempts: { increment: 1 },
            lastAttemptAt: attemptStartedAt,
            nextAttemptAt: null,
            processedAt: null,
            outcome: 'processing',
            error: null,
          },
        });
        if (claimed.count === 0) throw new Error(`Webhook ${provider}/${parsed.eventId} was claimed by another worker`);
        receipt = {
          ...existing,
          eventType: parsed.type,
          signatureOk: true,
          payload,
          attempts: existing.attempts + 1,
          lastAttemptAt: attemptStartedAt,
          nextAttemptAt: null,
          processedAt: null,
          outcome: 'processing',
          error: null,
        };
        logger.info({ provider, eventId: parsed.eventId, type: parsed.type, receiptId: receipt.id }, 'webhook redelivery reclaimed for processing');
      } else {
        throw e;
      }
    }
    // Paddle requires a webhook acknowledgement within five seconds. The
    // receipt is already durable, so process it after returning the 200; the
    // worker's maintenance loop reclaims this claim if the API dies here.
    void this.processWebhookReceipt({ id: receipt.id, provider: receipt.provider, attempts: receipt.attempts }, gateway, parsed, false).catch((err: unknown) =>
      logger.error({ err, receiptId: receipt.id, provider }, 'background webhook processor escaped its error boundary'),
    );
    return { status: 'accepted' };
  }

  /**
   * Redrive verified receipts after gateway retries are exhausted, and close
   * locally-cancelled subscriptions once their already-paid period ends.
   * Safe to run from every worker process: each receipt is conditionally
   * claimed and every financial action beneath it is idempotent.
   */
  async maintenanceTick(now = new Date()): Promise<{
    receipts: number;
    recovered: number;
    failed: number;
    subscriptionsEnded: number;
    refundsChecked: number;
    refundsCompleted: number;
    providerCancellations: number;
    checkoutsChecked: number;
    checkoutsResolved: number;
  }> {
    const ended = await this.db.subscription.updateMany({
      where: {
        status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] },
        cancelAtPeriodEnd: true,
        currentPeriodEnd: { lte: now },
      },
      data: { status: 'CANCELLED' },
    });
    const staleAt = new Date(now.getTime() - WEBHOOK_PROCESSING_TIMEOUT_MS);
    const due = await this.db.webhookReceipt.findMany({
      where: {
        signatureOk: true,
        attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
        OR: [
          { outcome: null, processedAt: null, receivedAt: { lte: staleAt } },
          { outcome: 'error', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { outcome: 'processing', OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: staleAt } }] },
        ],
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { receivedAt: 'asc' }],
      take: 50,
    });
    let recovered = 0;
    let failed = 0;
    for (const receipt of due) {
      const gateway = this.gateways.get(receipt.provider);
      if (!gateway) {
        failed += 1;
        logger.error({ receiptId: receipt.id, provider: receipt.provider }, 'verified webhook cannot be redriven because its gateway is not configured');
        continue;
      }
      const claimed = await this.db.webhookReceipt.updateMany({
        where: {
          id: receipt.id,
          outcome: receipt.outcome,
          attempts: receipt.attempts,
          lastAttemptAt: receipt.lastAttemptAt,
        },
        data: {
          outcome: 'processing',
          attempts: { increment: 1 },
          lastAttemptAt: now,
          nextAttemptAt: null,
          processedAt: null,
          error: null,
        },
      });
      if (claimed.count === 0) continue;
      const parsed: ParsedWebhook = {
        signatureOk: true,
        eventId: receipt.eventId,
        type: receipt.eventType,
        body: receipt.payload,
      };
      const result = await this.processWebhookReceipt({ id: receipt.id, provider: receipt.provider, attempts: receipt.attempts + 1 }, gateway, parsed, false);
      if (result.status === 'ok') recovered += 1;
      else failed += 1;
    }
    const checkoutRecovery = await this.reconcileUncertainCheckouts(now);
    const refundRecovery = await this.reconcilePendingRefunds(now);
    const cancellationRecovery = await this.reconcileProviderCancellations(now);
    return {
      receipts: due.length,
      recovered,
      failed: failed + refundRecovery.failed + cancellationRecovery.failed,
      subscriptionsEnded: ended.count,
      refundsChecked: refundRecovery.checked,
      refundsCompleted: refundRecovery.completed,
      providerCancellations: cancellationRecovery.completed,
      checkoutsChecked: checkoutRecovery.checked,
      checkoutsResolved: checkoutRecovery.resolved,
    };
  }

  /**
   * A timeout after checkout creation is ambiguous: the provider may have
   * accepted the request although its response never reached us. Reconcile by
   * the Payment's immutable merchant reference; never issue a second create.
   */
  private async reconcileUncertainCheckouts(now = new Date()): Promise<{ checked: number; resolved: number }> {
    const orphanCutoff = new Date(now.getTime() - CHECKOUT_ORPHAN_AFTER_MS);
    const rows = await this.db.payment.findMany({
      where: {
        status: 'PENDING',
        checkoutUrl: null,
        OR: [
          { failureReason: { startsWith: 'checkout setup uncertain:' } },
          { failureReason: { startsWith: 'checkout persistence uncertain:' } },
          { failureReason: { startsWith: 'checkout reconciliation pending:' } },
          // Covers the crash/DB-outage window after the provider returned a
          // page but before either the page or an uncertainty marker committed.
          { createdAt: { lte: orphanCutoff } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: 25,
    });
    let checked = 0;
    let resolved = 0;
    for (const payment of rows) {
      const attempts = checkoutRecoveryAttempts(payment.providerPayload);
      if (attempts >= CHECKOUT_RECONCILE_MAX_ATTEMPTS) {
        await this.failUncreatedCheckout(payment, `checkout abandoned: automatic reconciliation exhausted after ${attempts} attempts`);
        resolved += 1;
        continue;
      }
      const gateway = this.gateways.get(payment.provider);
      if (!gateway) {
        const next = attempts + 1;
        if (next >= CHECKOUT_RECONCILE_MAX_ATTEMPTS) {
          await this.failUncreatedCheckout(payment, `checkout abandoned: ${payment.provider} was unavailable for ${next} reconciliation attempts`);
          resolved += 1;
          continue;
        }
        await this.db.payment.update({
          where: { id: payment.id },
          data: {
            failureReason: 'checkout reconciliation pending: payment gateway is not configured; operator action required',
            providerPayload: checkoutRecoveryPayload(payment.providerPayload, next, 'payment gateway is not configured'),
          },
        });
        continue;
      }
      checked += 1;
      let verification: Verification;
      try {
        // Flutterwave resolves this by tx_ref. Paddle rows normally already
        // have their transaction id; a response-lost create has no safe list
        // filter, so its adapter correctly leaves the result pending.
        verification = await gateway.verify(payment);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const next = attempts + 1;
        if (next >= CHECKOUT_RECONCILE_MAX_ATTEMPTS) {
          await this.failUncreatedCheckout(payment, `checkout abandoned: provider reconciliation failed ${next} times; ${detail}`);
          resolved += 1;
          continue;
        }
        await this.db.payment.update({
          where: { id: payment.id },
          data: {
            failureReason: `checkout reconciliation pending: ${detail}`,
            providerPayload: checkoutRecoveryPayload(payment.providerPayload, next, detail),
          },
        });
        continue;
      }
      if (verification.ok || verification.state === 'failed') {
        await this.settle(payment, verification, 'return');
        resolved += 1;
        continue;
      }
      const next = attempts + 1;
      const exhausted = next >= CHECKOUT_RECONCILE_MAX_ATTEMPTS;
      if (exhausted) {
        await this.failUncreatedCheckout(payment, `checkout abandoned: provider still reported pending after ${next} reconciliation attempts`);
        resolved += 1;
        continue;
      }
      await this.db.payment.update({
        where: { id: payment.id },
        data: {
          failureReason: `checkout reconciliation pending: ${verification.reason}`,
          providerPayload: checkoutRecoveryPayload(payment.providerPayload, next, verification.reason),
        },
      });
    }
    return { checked, resolved };
  }

  /** Release reservations only after a provider response definitively rejected creation. */
  private async failUncreatedCheckout(payment: Payment, reason: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const failed = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PENDING', checkoutUrl: null },
        data: { status: 'FAILED', failureReason: reason },
      });
      // Persisting the provider page may have won this race. Never detach its
      // invoice unless this transaction actually claimed PENDING -> FAILED.
      if (failed.count === 1 && payment.kind === 'INVOICE') {
        await tx.invoice.updateMany({ where: { paymentId: payment.id, status: { notIn: ['PAID', 'VOID'] } }, data: { paymentId: null } });
      }
    });
  }

  /** Persist the provider page before returning it to the browser. */
  private async persistCheckoutSession(payment: Payment, session: CheckoutSession): Promise<void> {
    const data = { checkoutUrl: session.url, providerRef: session.providerRef };
    const persistIfOpen = async (): Promise<boolean> => {
      const written = await this.db.payment.updateMany({
        where: { id: payment.id, status: 'PENDING', checkoutUrl: null },
        data,
      });
      if (written.count === 1) return true;
      // updateMany returning zero can also mean the first write committed but
      // its acknowledgement was lost. Treat that exact persisted page as a
      // successful idempotent retry; every terminal/rival state loses.
      const current = await this.db.payment.findUnique({ where: { id: payment.id }, select: { status: true, checkoutUrl: true, providerRef: true } });
      return (
        current?.status === 'PENDING' &&
        current.checkoutUrl === session.url &&
        current.providerRef === (session.providerRef === undefined ? null : session.providerRef)
      );
    };
    try {
      if (await persistIfOpen()) return;
      throw new ConflictError('This checkout was already closed before its payment page could be saved. The page was not returned.');
    } catch (firstError) {
      if (firstError instanceof ConflictError) throw firstError;
      // A single connection failover should not strand a perfectly usable
      // provider page. Retry the exact idempotent local write once.
      try {
        if (!(await persistIfOpen())) {
          throw new ConflictError('This checkout was already closed before its payment page could be saved. The page was not returned.');
        }
        logger.warn({ err: firstError, paymentId: payment.id, provider: payment.provider }, 'checkout session persisted after a transient database failure');
        return;
      } catch (secondError) {
        if (secondError instanceof ConflictError) throw secondError;
        const detail = secondError instanceof Error ? secondError.message : String(secondError);
        // Best effort only: if the database is still unavailable, the orphan
        // age query above finds the original PENDING row once it returns.
        await this.db.payment
          .updateMany({
            where: { id: payment.id, status: 'PENDING', checkoutUrl: null },
            data: {
              failureReason: `checkout persistence uncertain: ${detail}`,
              providerPayload: checkoutRecoveryPayload(payment.providerPayload, 0, detail),
            },
          })
          .catch((classificationError: unknown) =>
            logger.error(
              { err: classificationError, paymentId: payment.id, provider: payment.provider },
              'checkout session and its recovery marker could not be persisted',
            ),
          );
        logger.error({ err: secondError, paymentId: payment.id, provider: payment.provider }, 'provider checkout exists but its page could not be persisted');
        throw new ConflictError('The payment page could not be saved and was not returned. This attempt is being reconciled; please try again later.');
      }
    }
  }

  private async processWebhookReceipt(
    receipt: Pick<WebhookReceipt, 'id' | 'provider' | 'attempts'>,
    gateway: Gateway,
    parsed: ParsedWebhook,
    rethrow: boolean,
  ): Promise<{ status: string; outcome?: string }> {
    try {
      const outcome = await this.act(gateway, gateway.interpret(parsed));
      if (WEBHOOK_DEFER_OUTCOMES.has(outcome)) throw new Error(`Webhook dependency is not ready: ${outcome}`);
      await this.db.webhookReceipt.update({
        where: { id: receipt.id },
        data: { processedAt: new Date(), nextAttemptAt: null, outcome, error: null },
      });
      logger.info({ provider: receipt.provider, eventId: parsed.eventId, type: parsed.type, outcome, receiptId: receipt.id }, 'webhook processed');
      return { status: 'ok', outcome };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const exhausted = receipt.attempts >= WEBHOOK_MAX_ATTEMPTS;
      const outcome = exhausted ? 'dead_letter' : 'error';
      await this.db.webhookReceipt.update({
        where: { id: receipt.id },
        data: {
          processedAt: exhausted ? new Date() : null,
          outcome,
          error,
          nextAttemptAt: exhausted ? null : new Date(Date.now() + webhookRetryDelay(receipt.attempts)),
        },
      });
      logger.error(
        { err, provider: receipt.provider, eventId: parsed.eventId, type: parsed.type, receiptId: receipt.id, attempts: receipt.attempts, outcome },
        exhausted ? 'WEBHOOK DEAD LETTER: manual reconciliation required' : 'webhook processing failed; retry scheduled',
      );
      if (rethrow && !exhausted) throw err;
      return { status: exhausted ? 'dead_letter' : 'retry_scheduled', outcome };
    }
  }

  private async act(gateway: Gateway, intent: WebhookIntent): Promise<string> {
    switch (intent.kind) {
      case 'ignore':
        return `ignored: ${intent.why}`;
      case 'charge': {
        let payment = intent.providerRef ? await this.db.payment.findFirst({ where: { provider: gateway.provider, providerRef: intent.providerRef } }) : null;
        let resolvedIntent = intent;
        if (!payment && !intent.subscriptionRef && intent.providerRef && gateway.resolveSubscriptionRef) {
          const subscriptionRef = await gateway.resolveSubscriptionRef(intent.providerRef);
          if (subscriptionRef) resolvedIntent = { ...intent, subscriptionRef };
        }
        // Resolve and match the provider subscription before considering an
        // echoed merchant reference. Recurring transactions commonly inherit
        // the first checkout's reference; choosing it would silently discard
        // a real renewal as an already-settled initial payment.
        if (!payment) payment = await this.renewalPayment(gateway.provider, resolvedIntent);
        if (!payment && intent.reference) {
          const referenced = await this.db.payment.findUnique({ where: { reference: intent.reference } });
          if (referenced?.provider === gateway.provider) payment = referenced;
        }
        if (!payment) return 'no_payment';
        if (payment.status === 'REFUNDED' && payment.ledgerEntryId === null && (payment.kind === 'SUBSCRIPTION' || payment.kind === 'RENEWAL')) {
          // Old releases could refund an initial charge before ever saving its
          // subscription. Recover the provider cancellation without granting
          // credits or issuing the same monetary refund a second time.
          const verification = await gateway.verify(payment, intent.providerRef ? { providerRef: intent.providerRef } : undefined);
          if (!verification.ok) return 'pending';
          return this.db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = CAST(${payment.id} AS uuid) FOR UPDATE`;
            const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
            if (fresh.status !== 'REFUNDED' || fresh.ledgerEntryId !== null) return 'already_settled';
            const linked = fresh.subscriptionId ? await tx.subscription.findUnique({ where: { id: fresh.subscriptionId } }) : null;
            if (linked?.status === 'CANCELLED') return 'already_settled';
            // Never cancel a newer paid period because of an old refund.
            if (linked) {
              const funded = await tx.payment.count({ where: { subscriptionId: linked.id, ledgerEntryId: { not: null } } });
              if (funded > 0) return 'already_settled';
            }
            const subscriptionId = await this.queueSubscriptionCancellation(tx, fresh, verification);
            if (!subscriptionId) return 'pending';
            await tx.payment.update({ where: { id: fresh.id }, data: { subscriptionId } });
            return 'refunded_subscription_cancel_queued';
          });
        }
        const recoverableEarlyAdjustment = isRecoverableEarlyAdjustment(payment);
        if (intent.status === 'failed') {
          if (payment.status === 'SUCCEEDED' || payment.status === 'REFUNDED' || (payment.status === 'NEEDS_REVIEW' && !recoverableEarlyAdjustment))
            return 'already_settled';
          // Webhook envelopes are hints, including failure envelopes. Re-fetch
          // the transaction before making a financial row terminal; gateways
          // may deliver paid/completed and failed-looking events out of order.
          const verification = await gateway.verify(payment, intent.providerRef ? { providerRef: intent.providerRef } : undefined);
          if (verification.ok && recoverableEarlyAdjustment) {
            const recovered = await this.reapplyRecoverableEarlyAdjustment(payment, verification);
            if (recovered) return recovered;
          }
          const settled = await this.settle(payment, verification, 'webhook');
          return settled.status === 'SUCCEEDED' ? 'granted' : settled.status === 'FAILED' ? 'failed' : 'pending';
        }
        if (intent.status === 'pending') return 'pending';
        if (payment.status === 'SUCCEEDED' || payment.status === 'REFUNDED' || (payment.status === 'NEEDS_REVIEW' && !recoverableEarlyAdjustment))
          return 'already_settled';
        const v = await gateway.verify(payment, intent.providerRef ? { providerRef: intent.providerRef } : undefined);
        if (v.ok && recoverableEarlyAdjustment) {
          const recovered = await this.reapplyRecoverableEarlyAdjustment(payment, v);
          if (recovered) return recovered;
        }
        const settled = await this.settle(payment, v, 'webhook');
        return settled.status === 'SUCCEEDED' ? 'granted' : settled.status === 'FAILED' ? `failed: ${settled.failureReason ?? ''}` : 'pending';
      }
      case 'subscription': {
        // Flutterwave's providerRef is a payment-plan id shared by many
        // customers, so the customer reference is part of its identity. For
        // Paddle this is simply an additional consistency check.
        const identity: Prisma.SubscriptionWhereInput = intent.subscriptionRef
          ? { providerRef: intent.subscriptionRef }
          : intent.catalogueRef && intent.customerRef
            ? { catalogueRef: intent.catalogueRef, customerRef: intent.customerRef }
            : { id: '__missing_subscription_identity__' };
        const directMatches = await this.db.subscription.findMany({
          where: { provider: gateway.provider, ...identity, ...(intent.customerRef ? { customerRef: intent.customerRef } : {}) },
          orderBy: { createdAt: 'desc' },
          take: 2,
        });
        if (directMatches.length > 1) {
          throw new Error(
            `Subscription identity ${gateway.provider}/${intent.subscriptionRef ?? `${intent.catalogueRef}/${intent.customerRef}`} is ambiguous; manual reconciliation required`,
          );
        }
        let sub = directMatches[0] ?? null;
        if (!sub && intent.reference) {
          const p = await this.db.payment.findUnique({ where: { reference: intent.reference } });
          if (p?.subscriptionId) sub = await this.db.subscription.findUnique({ where: { id: p.subscriptionId } });
          if (!sub && p)
            sub = await this.db.subscription.findFirst({
              where: { workspaceId: p.workspaceId, status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } },
              orderBy: { createdAt: 'desc' },
            });
        }
        if (!sub) return 'no_subscription';
        return this.db.$transaction(async (tx) => {
          // Successful renewals use the same workspace -> subscription lock
          // order. Reload after both locks so neither path can overwrite a
          // state or paid period read before its competitor committed.
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "workspaces" WHERE "id" = CAST(${sub.workspaceId} AS uuid) FOR UPDATE
          `;
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "subscriptions" WHERE "id" = CAST(${sub.id} AS uuid) FOR UPDATE
          `;
          const locked = await tx.subscription.findUnique({ where: { id: sub.id } });
          if (!locked) return 'no_subscription';
          if (intent.occurredAt && locked.providerUpdatedAt && intent.occurredAt.getTime() <= locked.providerUpdatedAt.getTime()) {
            logger.info(
              {
                subscriptionId: locked.id,
                provider: gateway.provider,
                eventAt: intent.occurredAt,
                currentProviderUpdatedAt: locked.providerUpdatedAt,
              },
              'stale subscription webhook ignored',
            );
            return 'subscription_stale';
          }

          const now = new Date();
          // Paddle emits subscription.updated + scheduled_change while a
          // future cancellation is merely scheduled. subscription.canceled is
          // terminal at the effective date. Status follows provider event
          // time, while period dates only advance: a later-delivered status
          // event for an older period cannot shorten already-paid service.
          const providerStatus =
            intent.status === 'active' ? 'ACTIVE' : intent.status === 'past_due' ? 'PAST_DUE' : intent.status === 'paused' ? 'PAUSED' : 'CANCELLED';
          // There is deliberately no local "resume billing" command. Once a
          // customer asks to cancel, a delayed provider snapshot cannot erase
          // that command after its API acknowledgement. Likewise, a refund's
          // immediate CANCELLED state must not be resurrected while the durable
          // provider-cancel outbox is still draining.
          const localCancellationRequested = locked.cancelledAt !== null && (locked.cancelAtPeriodEnd || locked.status === 'CANCELLED');
          const status = intent.status === 'cancelled' ? 'CANCELLED' : localCancellationRequested ? locked.status : providerStatus;
          const periodAdvances = intent.periodEnd
            ? !locked.currentPeriodEnd || intent.periodEnd.getTime() > locked.currentPeriodEnd.getTime()
            : Boolean(!locked.currentPeriodEnd && intent.periodStart && (!locked.currentPeriodStart || intent.periodStart > locked.currentPeriodStart));
          await tx.subscription.update({
            where: { id: locked.id },
            data: {
              status,
              providerRef: locked.providerRef ?? intent.subscriptionRef,
              catalogueRef: locked.catalogueRef ?? intent.catalogueRef,
              customerRef: intent.customerRef ?? locked.customerRef,
              currentPeriodStart: periodAdvances ? (intent.periodStart ?? locked.currentPeriodStart) : locked.currentPeriodStart,
              currentPeriodEnd: periodAdvances ? (intent.periodEnd ?? locked.currentPeriodEnd) : locked.currentPeriodEnd,
              cancelAtPeriodEnd:
                intent.status === 'cancelled'
                  ? false
                  : localCancellationRequested
                    ? locked.cancelAtPeriodEnd
                    : (intent.cancelAtPeriodEnd ?? locked.cancelAtPeriodEnd),
              cancelledAt: intent.status === 'cancelled' ? (locked.cancelledAt ?? now) : locked.cancelledAt,
              providerUpdatedAt: intent.occurredAt ?? locked.providerUpdatedAt,
              providerCancelPending: intent.status === 'cancelled' ? false : locked.providerCancelPending,
              providerCancelNextAt: intent.status === 'cancelled' ? null : locked.providerCancelNextAt,
              providerCancelError: intent.status === 'cancelled' ? null : locked.providerCancelError,
            },
          });
          logger.info(
            { subscriptionId: locked.id, workspaceId: locked.workspaceId, status, cancelAtPeriodEnd: intent.cancelAtPeriodEnd },
            'subscription updated from webhook',
          );
          return `subscription_${status.toLowerCase()}`;
        });
      }
      case 'refund': {
        let paymentProviderRef = intent.providerRef;
        let adjustmentRef = intent.refundRef;
        if (!paymentProviderRef && adjustmentRef && gateway.resolveAdjustment) {
          const resolved = await gateway.resolveAdjustment(adjustmentRef);
          paymentProviderRef = resolved?.paymentProviderRef;
          adjustmentRef = resolved?.providerAdjustmentRef ?? adjustmentRef;
        }
        if (!paymentProviderRef) return 'no_payment';
        const payment = await this.db.payment.findFirst({ where: { provider: gateway.provider, providerRef: paymentProviderRef } });
        if (!payment) return 'no_payment';
        // A signed webhook is still only a notification. Re-fetch the
        // adjustment so forged amounts, partial refunds and out-of-order
        // status events cannot move credits.
        const verification = await gateway.verifyRefund(payment, adjustmentRef);
        return this.applyRefundVerification(payment, verification, intent.reason ?? 'refund');
      }
    }
  }

  /**
   * Repair the only review state that an older release could create before
   * charge fulfilment. Replaying any one terminal adjustment is sufficient:
   * applyConfirmedAdjustment derives the desired credit movement from the
   * signed aggregate of every adjustment on the payment.
   */
  private async reapplyRecoverableEarlyAdjustment(payment: Payment, charge: Extract<Verification, { ok: true }>): Promise<string | null> {
    const adjustment = await this.db.paymentAdjustment.findFirst({
      where: { paymentId: payment.id, status: { in: ['SUCCEEDED', 'REVERSED'] }, amountMinor: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!adjustment?.amountMinor) return null;
    const metadata = adjustmentProviderMetadata(adjustment.payload);
    return this.applyConfirmedAdjustment(
      payment,
      {
        state: adjustment.status === 'REVERSED' ? 'reversed' : 'succeeded',
        providerRef: adjustment.providerRef,
        amountMinor: adjustment.amountMinor,
        currency: adjustment.currency ?? payment.currency,
        providerAction: metadata.providerAction,
        reversalMode: metadata.reversalMode,
      },
      adjustment.reason === 'CHARGEBACK' ? 'chargeback' : 'refund',
      undefined,
      charge,
    );
  }

  private async applyRefundVerification(
    payment: Payment,
    verification: RefundVerification,
    reason: 'refund' | 'chargeback',
    cycle?: RefundCycleContext,
  ): Promise<string> {
    if (verification.providerAction === 'credit' || verification.providerAction === 'credit_reverse') {
      // Paddle invoice credits change a receivable rather than returning
      // captured cash. Preserve the provider fact for reconciliation without
      // treating it as a cash refund or silently discarding it.
      return this.markAdjustmentForReview(payment, verification, reason, `Paddle ${verification.providerAction} requires invoice reconciliation`, cycle);
    }
    if (verification.state === 'ignored') return 'adjustment_ignored';
    if (verification.state === 'pending') {
      return this.db.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "payments" WHERE "id" = CAST(${payment.id} AS uuid) FOR UPDATE
        `;
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "refund_requests" WHERE "paymentId" = CAST(${payment.id} AS uuid) FOR UPDATE
        `;
        const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
        const request = await tx.refundRequest.findUnique({ where: { paymentId: fresh.id } });
        let boundCycle = refundCycleBinding(request, cycle, verification.providerRef, null, false);
        if (verification.providerRef) {
          let adjustment = await tx.paymentAdjustment.upsert({
            where: { provider_providerRef: { provider: fresh.provider, providerRef: verification.providerRef } },
            create: {
              paymentId: fresh.id,
              provider: fresh.provider,
              providerRef: verification.providerRef,
              reason: reason === 'chargeback' ? 'CHARGEBACK' : 'REFUND',
              status: 'PENDING',
              amountMinor: verification.amountMinor === undefined ? null : Math.abs(verification.amountMinor),
              currency: verification.currency?.toUpperCase(),
              failureReason: verification.reason,
              refundCycle: boundCycle?.refundCycle,
            },
            // A delayed "pending" event must never regress provider truth
            // already recorded as succeeded, failed or reversed.
            update: {},
          });
          if (adjustment.paymentId !== fresh.id) {
            const failure = `Adjustment is already attached to payment ${adjustment.paymentId}`;
            await tx.payment.update({ where: { id: fresh.id }, data: { status: 'NEEDS_REVIEW', failureReason: failure } });
            if (boundCycle)
              await tx.refundRequest.updateMany({
                where: { id: boundCycle.requestId, paymentId: fresh.id, refundCycle: boundCycle.refundCycle, status: 'PROCESSING' },
                data: { status: 'NEEDS_REVIEW', decisionNote: failure, lastError: failure, nextAttemptAt: null },
              });
            return 'adjustment_needs_review';
          }
          boundCycle = refundCycleBinding(request, cycle, verification.providerRef, adjustment.refundCycle, false);
          if (boundCycle && adjustment.refundCycle === null) {
            const bound = await tx.paymentAdjustment.updateMany({
              where: { id: adjustment.id, refundCycle: null },
              data: { refundCycle: boundCycle.refundCycle },
            });
            if (bound.count === 1) adjustment = { ...adjustment, refundCycle: boundCycle.refundCycle };
          }
          if (adjustment.status === 'PENDING') {
            await tx.paymentAdjustment.update({
              where: { id: adjustment.id },
              data: {
                amountMinor: verification.amountMinor === undefined ? undefined : Math.abs(verification.amountMinor),
                currency: verification.currency?.toUpperCase(),
                failureReason: verification.reason,
              },
            });
          }
          boundCycle = refundCycleBinding(request, cycle, verification.providerRef, adjustment.refundCycle, false);
        }
        if (boundCycle) {
          await tx.refundRequest.updateMany({
            where: {
              id: boundCycle.requestId,
              paymentId: fresh.id,
              status: 'PROCESSING',
              refundCycle: boundCycle.refundCycle,
            },
            data: {
              gatewayRef: verification.providerRef,
              decisionNote: 'Awaiting confirmation from the payment provider.',
              lastError: verification.reason ?? null,
              nextAttemptAt: new Date(Date.now() + REFUND_RECHECK_MS),
            },
          });
        }
        return 'refund_pending';
      });
    }
    if (verification.state === 'failed') {
      return this.releaseRefundReservation(payment, verification, reason, cycle);
    }
    return this.applyConfirmedAdjustment(payment, verification, reason, cycle);
  }

  private async releaseRefundReservation(
    payment: Payment,
    verification: RefundVerification,
    adjustmentReason: 'refund' | 'chargeback',
    cycle?: RefundCycleContext,
  ): Promise<string> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "payments" WHERE "id" = CAST(${payment.id} AS uuid) FOR UPDATE
      `;
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "refund_requests" WHERE "paymentId" = CAST(${payment.id} AS uuid) FOR UPDATE
      `;
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const request = await tx.refundRequest.findUnique({ where: { paymentId: payment.id } });
      let boundCycle = refundCycleBinding(request, cycle, verification.providerRef, null, false);
      if (verification.providerRef) {
        let adjustment = await tx.paymentAdjustment.upsert({
          where: { provider_providerRef: { provider: fresh.provider, providerRef: verification.providerRef } },
          create: {
            paymentId: fresh.id,
            provider: fresh.provider,
            providerRef: verification.providerRef,
            reason: adjustmentReason === 'chargeback' ? 'CHARGEBACK' : 'REFUND',
            status: 'FAILED',
            amountMinor: verification.amountMinor === undefined ? null : Math.abs(verification.amountMinor),
            currency: verification.currency?.toUpperCase(),
            failureReason: verification.reason,
            refundCycle: boundCycle?.refundCycle,
          },
          update: {},
        });
        if (adjustment.paymentId !== fresh.id) {
          const failure = `Rejected adjustment is attached to payment ${adjustment.paymentId}`;
          await tx.payment.update({ where: { id: fresh.id }, data: { status: 'NEEDS_REVIEW', failureReason: failure } });
          if (boundCycle)
            await tx.refundRequest.updateMany({
              where: { id: boundCycle.requestId, paymentId: fresh.id, refundCycle: boundCycle.refundCycle, status: 'PROCESSING' },
              data: { status: 'NEEDS_REVIEW', decisionNote: failure, lastError: failure, nextAttemptAt: null },
            });
          return 'adjustment_needs_review';
        }
        boundCycle = refundCycleBinding(request, cycle, verification.providerRef, adjustment.refundCycle, false);
        if (boundCycle && adjustment.refundCycle === null) {
          const bound = await tx.paymentAdjustment.updateMany({
            where: { id: adjustment.id, refundCycle: null },
            data: { refundCycle: boundCycle.refundCycle },
          });
          if (bound.count === 1) adjustment = { ...adjustment, refundCycle: boundCycle.refundCycle };
        }
        // A delayed failure cannot undo a terminal provider observation.
        if (adjustment.status === 'SUCCEEDED' || adjustment.status === 'REVERSED') return 'adjustment_already_final';
        await tx.paymentAdjustment.update({
          where: { id: adjustment.id },
          data: {
            status: 'FAILED',
            failureReason: verification.reason,
            amountMinor: verification.amountMinor === undefined ? undefined : Math.abs(verification.amountMinor),
            currency: verification.currency?.toUpperCase(),
          },
        });
        boundCycle = refundCycleBinding(request, cycle, verification.providerRef, adjustment.refundCycle, false);
      }
      const exhaustedSameCycle = request?.status === 'NEEDS_REVIEW' && request.lastError === REFUND_RECONCILIATION_EXHAUSTED;
      if (
        !request ||
        (request.status !== 'PROCESSING' && !exhaustedSameCycle) ||
        !boundCycle ||
        request.id !== boundCycle.requestId ||
        request.refundCycle !== boundCycle.refundCycle
      )
        return 'adjustment_already_final';
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { workspaceId: fresh.workspaceId }, select: { id: true } });
      const reservationKey = `${refundReservationKey(request.id, request.refundCycle)}:clawback`;
      const reservation = await tx.ledgerEntry.findUnique({
        where: {
          walletId_idempotencyKey: {
            walletId: wallet.id,
            idempotencyKey: reservationKey,
          },
        },
        select: { delta: true },
      });
      if (reservation && reservation.delta < 0) {
        await this.ledger.purchase(
          {
            walletId: wallet.id,
            amount: Math.abs(reservation.delta),
            idempotencyKey: refundReleaseKey(request.id, request.refundCycle),
            referenceId: fresh.id,
            reason: `Released credits after ${fresh.provider} refused refund`,
          },
          tx,
        );
      }
      const automatic = request.requestedById === null;
      await tx.refundRequest.updateMany({
        where: {
          id: request.id,
          status: exhaustedSameCycle ? 'NEEDS_REVIEW' : 'PROCESSING',
          refundCycle: request.refundCycle,
        },
        data: {
          status: automatic ? 'NEEDS_REVIEW' : 'REFUSED',
          gatewayRef: verification.providerRef,
          decisionNote: automatic ? `Automatic refund failed: ${verification.reason ?? 'The payment provider rejected the refund.'}` : verification.reason,
          lastError: verification.reason ?? 'The payment provider rejected the refund.',
          nextAttemptAt: null,
        },
      });
      if (!automatic && exhaustedSameCycle && fresh.status === 'NEEDS_REVIEW' && fresh.failureReason === REFUND_RECONCILIATION_EXHAUSTED) {
        const aggregate = await tx.paymentAdjustment.aggregate({
          where: { paymentId: fresh.id, status: { in: ['SUCCEEDED', 'REVERSED'] } },
          _sum: { amountDeltaMinor: true },
        });
        if ((aggregate._sum.amountDeltaMinor ?? 0) === 0) {
          await tx.payment.update({ where: { id: fresh.id }, data: { status: 'SUCCEEDED', failureReason: null } });
        }
      }
      return 'refund_failed';
    });
  }

  private async markAdjustmentForReview(
    payment: Payment,
    verification: RefundVerification,
    reason: 'refund' | 'chargeback',
    failure: string,
    cycle?: RefundCycleContext,
  ): Promise<string> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "payments" WHERE "id" = CAST(${payment.id} AS uuid) FOR UPDATE
      `;
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "refund_requests" WHERE "paymentId" = CAST(${payment.id} AS uuid) FOR UPDATE
      `;
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'NEEDS_REVIEW', failureReason: failure } });
      if (payment.kind === 'INVOICE' && (verification.providerAction === 'credit' || verification.providerAction === 'credit_reverse')) {
        await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "number" = ${payment.itemCode} FOR UPDATE`;
        const invoice = await tx.invoice.findUnique({ where: { number: payment.itemCode } });
        if (invoice?.paymentId === payment.id && !invoiceSettlementConflicts(invoice, payment)) {
          await tx.$queryRaw`SELECT "id" FROM "wallets" WHERE "workspaceId" = CAST(${payment.workspaceId} AS uuid) FOR UPDATE`;
          await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'DISPUTED' } });
          await tx.billingAccount.updateMany({
            where: { id: invoice.accountId, status: { not: 'CLOSED' } },
            data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendedReason: failure },
          });
          await tx.wallet.update({ where: { workspaceId: payment.workspaceId }, data: { overdraftLimit: 0 } });
        }
      }
      const request = await tx.refundRequest.findUnique({ where: { paymentId: payment.id } });
      let boundCycle = refundCycleBinding(request, cycle, verification.providerRef, null, false);
      if (verification.providerRef) {
        const existing = await tx.paymentAdjustment.findUnique({
          where: { provider_providerRef: { provider: payment.provider, providerRef: verification.providerRef } },
        });
        if (!existing) {
          const created = await tx.paymentAdjustment.create({
            data: {
              paymentId: payment.id,
              provider: payment.provider,
              providerRef: verification.providerRef,
              reason: reason === 'chargeback' ? 'CHARGEBACK' : 'REFUND',
              status: 'NEEDS_REVIEW',
              amountMinor: verification.amountMinor === undefined ? null : Math.abs(verification.amountMinor),
              currency: verification.currency?.toUpperCase(),
              failureReason: failure,
              refundCycle: boundCycle?.refundCycle,
              payload: adjustmentProviderPayload(null, verification),
            },
          });
          boundCycle = refundCycleBinding(request, cycle, verification.providerRef, created.refundCycle, false);
        } else if (existing.paymentId === payment.id) {
          boundCycle = refundCycleBinding(request, cycle, verification.providerRef, existing.refundCycle, false);
          if (boundCycle && existing.refundCycle === null) {
            await tx.paymentAdjustment.updateMany({
              where: { id: existing.id, refundCycle: null },
              data: { refundCycle: boundCycle.refundCycle },
            });
          }
        } else {
          boundCycle = null;
        }
      }
      if (boundCycle)
        await tx.refundRequest.updateMany({
          where: { id: boundCycle.requestId, paymentId: payment.id, refundCycle: boundCycle.refundCycle, status: 'PROCESSING' },
          data: {
            status: 'NEEDS_REVIEW',
            gatewayRef: verification.providerRef,
            decisionNote: failure,
            lastError: failure,
            nextAttemptAt: null,
          },
        });
    });
    logger.error({ paymentId: payment.id, provider: payment.provider, adjustmentRef: verification.providerRef, failure }, 'PAYMENT ADJUSTMENT NEEDS REVIEW');
    return 'adjustment_needs_review';
  }

  private async applyConfirmedAdjustment(
    payment: Payment,
    verification: RefundVerification,
    reason: 'refund' | 'chargeback',
    cycle?: RefundCycleContext,
    verifiedOriginalCharge?: Extract<Verification, { ok: true }>,
  ): Promise<string> {
    // Refund APIs describe an adjustment, not whether its original charge was
    // ever fulfilled locally. Resolve that dependency before opening the DB
    // transaction. A pending/failed lookup leaves the webhook receipt
    // retryable and, critically, does not turn the Payment terminal.
    const current = await this.db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const currentInvoice =
      current.kind === 'INVOICE'
        ? await this.db.invoice.findUnique({
            where: { number: current.itemCode },
            select: { status: true, paymentId: true, paidVia: true, paidReference: true },
          })
        : null;
    let originalCharge = verifiedOriginalCharge;
    if (!immutableOriginalChargeFulfilled(current, currentInvoice)) {
      const gateway = this.gateways.get(current.provider);
      if (!gateway) return 'refund_pending';
      const charge = originalCharge ?? (await gateway.verify(current, current.providerRef ? { providerRef: current.providerRef } : undefined));
      if (!charge.ok) return 'refund_pending';
      originalCharge = charge;
    }

    const adjustmentRef = verification.providerRef;
    if (!adjustmentRef) return this.markAdjustmentForReview(current, verification, reason, 'Provider adjustment has no stable id', cycle);
    if (verification.amountMinor === undefined || !Number.isFinite(verification.amountMinor) || verification.amountMinor <= 0) {
      return this.markAdjustmentForReview(current, verification, reason, `Provider adjustment ${adjustmentRef} has no verifiable positive amount`, cycle);
    }
    const authoritativeCurrency = originalCharge?.currency ?? current.currency;
    if (verification.currency && verification.currency.toUpperCase() !== authoritativeCurrency.toUpperCase()) {
      return this.markAdjustmentForReview(
        current,
        verification,
        reason,
        `Provider adjustment currency ${verification.currency} does not match payment currency ${authoritativeCurrency}`,
        cycle,
      );
    }
    const amount = Math.abs(verification.amountMinor);

    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "payments" WHERE "id" = CAST(${payment.id} AS uuid) FOR UPDATE
      `;
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "refund_requests" WHERE "paymentId" = CAST(${payment.id} AS uuid) FOR UPDATE
      `;
      let fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      let readinessInvoice =
        fresh.kind === 'INVOICE'
          ? await tx.invoice.findUnique({
              where: { number: fresh.itemCode },
              select: { status: true, paymentId: true, paidVia: true, paidReference: true },
            })
          : null;
      if (!immutableOriginalChargeFulfilled(fresh, readinessInvoice)) {
        if (!originalCharge) return 'refund_pending';
        await this.settle(fresh, originalCharge, 'webhook', tx);
        fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
        readinessInvoice =
          fresh.kind === 'INVOICE'
            ? await tx.invoice.findUnique({
                where: { number: fresh.itemCode },
                select: { status: true, paymentId: true, paidVia: true, paidReference: true },
              })
            : null;
        if (!immutableOriginalChargeFulfilled(fresh, readinessInvoice)) return 'refund_pending';
      }
      const request = await tx.refundRequest.findUnique({ where: { paymentId: fresh.id } });
      let boundCycle = refundCycleBinding(request, cycle, adjustmentRef, null, verification.state === 'succeeded');
      let adjustment = await tx.paymentAdjustment.findUnique({
        where: { provider_providerRef: { provider: fresh.provider, providerRef: adjustmentRef } },
      });
      if (adjustment && adjustment.paymentId !== fresh.id) {
        await tx.payment.update({
          where: { id: fresh.id },
          data: { status: 'NEEDS_REVIEW', failureReason: `Adjustment ${adjustmentRef} belongs to payment ${adjustment.paymentId}` },
        });
        return 'adjustment_needs_review';
      }
      if (!adjustment && fresh.status === 'REFUNDED') {
        // Releases before PaymentAdjustment existed stored only Payment=REFUNDED
        // and (when possible) a legacy ledger clawback. The forward migration
        // creates one synthetic adjustment for that history. Adopt the first
        // real immutable provider id under the payment lock so a redelivery
        // cannot create a second economic adjustment, and a later reversal can
        // restore exactly the migrated delta.
        const legacy = await tx.paymentAdjustment.findMany({
          where: { paymentId: fresh.id, providerRef: { startsWith: 'legacy-refund:' } },
          orderBy: { createdAt: 'asc' },
          take: 2,
        });
        const nonLegacy = await tx.paymentAdjustment.count({
          where: { paymentId: fresh.id, providerRef: { not: { startsWith: 'legacy-refund:' } } },
        });
        let historical = legacy[0];
        if (!historical && nonLegacy === 0) {
          // Migrations run before an old Render release is drained. An old
          // replica can therefore record REFUNDED after the one-shot SQL
          // backfill. Reconstruct that legacy fact at runtime as well.
          const historicalWallet = await tx.wallet.findUnique({ where: { workspaceId: fresh.workspaceId }, select: { id: true } });
          const clawback = historicalWallet
            ? await tx.ledgerEntry.findUnique({
                where: {
                  walletId_idempotencyKey: {
                    walletId: historicalWallet.id,
                    idempotencyKey: `payment:${fresh.id}:clawback`,
                  },
                },
                select: { delta: true },
              })
            : null;
          historical = await tx.paymentAdjustment.create({
            data: {
              paymentId: fresh.id,
              provider: fresh.provider,
              providerRef: `legacy-refund:${fresh.id}`,
              reason: 'REFUND',
              status: 'SUCCEEDED',
              amountMinor: fresh.amountMinor,
              amountDeltaMinor: -fresh.amountMinor,
              currency: fresh.currency,
              creditDelta: clawback?.delta ?? 0,
              ledgerRevision: clawback?.delta ? 1 : 0,
              appliedAt: fresh.refundedAt ?? fresh.updatedAt,
              refundCycle: request?.status === 'APPROVED' ? request.refundCycle : undefined,
              payload: { migratedLegacyRefund: true, reconstructedDuringRollingDeploy: true },
            },
          });
        }
        if (historical && legacy.length <= 1 && nonLegacy === 0) {
          adjustment = await tx.paymentAdjustment.update({
            where: { id: historical.id },
            data: {
              providerRef: adjustmentRef,
              refundCycle: historical.refundCycle ?? (request?.status === 'APPROVED' ? request.refundCycle : undefined),
            },
          });
        }
      }
      if (!adjustment) {
        adjustment = await tx.paymentAdjustment.upsert({
          where: { provider_providerRef: { provider: fresh.provider, providerRef: adjustmentRef } },
          create: {
            paymentId: fresh.id,
            provider: fresh.provider,
            providerRef: adjustmentRef,
            reason: reason === 'chargeback' ? 'CHARGEBACK' : 'REFUND',
            status: 'PENDING',
            amountMinor: amount,
            currency: verification.currency?.toUpperCase() ?? fresh.currency,
            refundCycle: boundCycle?.refundCycle,
          },
          update: {},
        });
        if (adjustment.paymentId !== fresh.id) {
          await tx.payment.update({
            where: { id: fresh.id },
            data: { status: 'NEEDS_REVIEW', failureReason: `Adjustment ${adjustmentRef} belongs to payment ${adjustment.paymentId}` },
          });
          return 'adjustment_needs_review';
        }
      }
      const terminalSuccessMayAdopt = verification.state === 'succeeded' && adjustment.status !== 'REVERSED';
      boundCycle = refundCycleBinding(request, cycle, adjustmentRef, adjustment.refundCycle, terminalSuccessMayAdopt);
      if (boundCycle && adjustment.refundCycle === null) {
        const bound = await tx.paymentAdjustment.updateMany({
          where: { id: adjustment.id, refundCycle: null },
          data: { refundCycle: boundCycle.refundCycle },
        });
        if (bound.count === 1) adjustment = { ...adjustment, refundCycle: boundCycle.refundCycle };
      }
      boundCycle = refundCycleBinding(request, cycle, adjustmentRef, adjustment.refundCycle, terminalSuccessMayAdopt);
      // REVERSED is terminal for this immutable provider adjustment id. A
      // stale provider GET that still says "succeeded" must not claw credits
      // back a second time; a new refund cycle must receive a new adjustment.
      if (adjustment.status === 'REVERSED') return 'refund_reversed';

      if (fresh.kind === 'INVOICE') {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "invoices" WHERE "number" = ${fresh.itemCode} FOR UPDATE
        `;
      }
      const invoice = fresh.kind === 'INVOICE' ? await tx.invoice.findUnique({ where: { number: fresh.itemCode } }) : null;
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { workspaceId: fresh.workspaceId }, select: { id: true } });
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "wallets" WHERE "id" = CAST(${wallet.id} AS uuid) FOR UPDATE
      `;
      const reservation = boundCycle
        ? await tx.ledgerEntry.findUnique({
            where: {
              walletId_idempotencyKey: {
                walletId: wallet.id,
                idempotencyKey: `${refundReservationKey(boundCycle.requestId, boundCycle.refundCycle)}:clawback`,
              },
            },
            select: { delta: true },
          })
        : null;
      const reservationRelease = boundCycle
        ? await tx.ledgerEntry.findUnique({
            where: {
              walletId_idempotencyKey: {
                walletId: wallet.id,
                idempotencyKey: refundReleaseKey(boundCycle.requestId, boundCycle.refundCycle),
              },
            },
            select: { id: true },
          })
        : null;
      const purchaseEntries = await tx.ledgerEntry.findMany({
        where: {
          walletId: wallet.id,
          kind: 'PURCHASE',
          delta: { gt: 0 },
          // Immutable funding only. Adjustment reversals are also PURCHASE
          // rows with this payment as reference, so referenceId alone would
          // count restored credits as a second original purchase.
          OR: [
            { idempotencyKey: `payment:${fresh.id}` },
            { idempotencyKey: { startsWith: `payment:${fresh.id}:annual-month:` } },
            ...(fresh.ledgerEntryId ? [{ id: fresh.ledgerEntryId }] : []),
          ],
        },
        select: { delta: true },
      });
      const fundedCredits = purchaseEntries.reduce((sum, entry) => sum + entry.delta, 0);
      const otherAdjustments = await tx.paymentAdjustment.findMany({
        where: { paymentId: fresh.id, id: { not: adjustment.id }, status: { in: ['SUCCEEDED', 'REVERSED'] } },
        select: {
          id: true,
          providerRef: true,
          amountMinor: true,
          amountDeltaMinor: true,
          creditDelta: true,
          payload: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const otherCredits = otherAdjustments.reduce((sum, row) => sum + row.creditDelta, 0);
      const otherAmount = otherAdjustments.reduce((sum, row) => sum + row.amountDeltaMinor, 0);
      const currentProviderMetadata = adjustmentProviderMetadata(adjustment.payload);
      const providerAction = normalizedAdjustmentAction(verification.providerAction ?? currentProviderMetadata.providerAction);
      const reversalMode = verification.reversalMode ?? currentProviderMetadata.reversalMode;
      const separateReverseAction = reversalMode === 'separate_adjustment' ? originalActionForReverse(providerAction) : null;
      const counterpartAction =
        separateReverseAction ??
        (reversalMode === 'separate_adjustment' && verification.state === 'reversed' && providerAction ? `${providerAction}_reverse` : null);
      const linkedCounterpartRef = separateReverseAction
        ? currentProviderMetadata.economicReversalOfProviderRef
        : currentProviderMetadata.economicReversedByProviderRef;
      const matchingCounterparts = counterpartAction
        ? otherAdjustments.filter((row) => {
            const metadata = adjustmentProviderMetadata(row.payload);
            if (metadata.reversalMode !== 'separate_adjustment' || normalizedAdjustmentAction(metadata.providerAction) !== counterpartAction) return false;
            if (row.amountMinor !== amount) return false;
            if (linkedCounterpartRef && row.providerRef !== linkedCounterpartRef) return false;
            const reciprocalRef = separateReverseAction ? metadata.economicReversedByProviderRef : metadata.economicReversalOfProviderRef;
            return !reciprocalRef || reciprocalRef === adjustmentRef;
          })
        : [];
      const matchingCounterpart = matchingCounterparts[0];
      const sameAdjustmentReversed = verification.state === 'reversed' && adjustment.amountDeltaMinor < 0;
      let targetAmountDelta: number;
      if (verification.state === 'succeeded') {
        targetAmountDelta = -amount;
      } else if (separateReverseAction) {
        // A Paddle *_reverse record is the positive half of the provider's
        // dual representation. If the original status envelope already
        // represented the reversal with a zero delta, this row is also zero;
        // otherwise it offsets the exact linked negative row.
        targetAmountDelta = matchingCounterpart ? Math.max(0, -matchingCounterpart.amountDeltaMinor) : amount;
      } else if (reversalMode === 'separate_adjustment' && providerAction) {
        // Paddle also changes the original adjustment itself to REVERSED. If
        // its separate reverse row is already present, retain/construct the
        // original negative half; otherwise this status envelope represents
        // the net-zero reversal and restores the original row to zero. This
        // makes all delivery permutations commute without double-restoring.
        targetAmountDelta = matchingCounterpart ? -Math.max(0, matchingCounterpart.amountDeltaMinor) : 0;
      } else if (sameAdjustmentReversed) {
        targetAmountDelta = 0;
      } else {
        // Providers without a declared dual-reversal model may use a distinct
        // reversal id. Preserve that positive fact even when it arrives before
        // its corresponding debit; a later success then converges to zero.
        targetAmountDelta = amount;
      }
      const targetAmountNet = otherAmount + targetAmountDelta;
      const moneyStillWithheld = Math.min(fresh.amountMinor, Math.max(0, -targetAmountNet));
      const creditsStillWithheld =
        fundedCredits > 0 && fresh.amountMinor > 0 ? Math.min(fundedCredits, Math.ceil((fundedCredits * moneyStillWithheld) / fresh.amountMinor)) : 0;
      // This row owns whatever signed credit delta makes the aggregate match
      // the aggregate monetary truth. This remains correct for 60% + 60%
      // over-return followed by reversal of either row; per-adjustment caps do
      // not, because webhook order changes which row carried the final 40%.
      const targetCreditDelta = -creditsStillWithheld - otherCredits;

      const reservationCoversThisAdjustment =
        adjustment.creditDelta === 0 &&
        reservation &&
        reservation.delta < 0 &&
        !reservationRelease &&
        (verification.state === 'succeeded' || verification.state === 'reversed');
      const effectiveCurrentCreditDelta = reservationCoversThisAdjustment ? reservation.delta : adjustment.creditDelta;
      const amountMovement = targetAmountDelta - adjustment.amountDeltaMinor;
      const creditMovement = targetCreditDelta - effectiveCurrentCreditDelta;
      const ledgerRevision = adjustment.ledgerRevision + 1;
      if (creditMovement < 0) {
        await this.ledger.forceClawback(
          {
            walletId: wallet.id,
            amount: Math.abs(creditMovement),
            idempotencyKey: `payment-adjustment:${adjustment.id}:movement:${ledgerRevision}`,
            referenceId: fresh.id,
            reason: `${reason === 'chargeback' ? 'Chargeback' : 'Refund'} of ${fresh.itemCode}`,
          },
          tx,
        );
      } else if (creditMovement > 0) {
        await this.ledger.purchase(
          {
            walletId: wallet.id,
            amount: creditMovement,
            idempotencyKey: `payment-adjustment:${adjustment.id}:movement:${ledgerRevision}`,
            referenceId: fresh.id,
            reason: sameAdjustmentReversed ? `Reversal of ${reason} for ${fresh.itemCode}` : `Unused refund reservation released for ${fresh.itemCode}`,
          },
          tx,
        );
      }

      adjustment = await tx.paymentAdjustment.update({
        where: { id: adjustment.id },
        data: {
          reason: reason === 'chargeback' ? 'CHARGEBACK' : 'REFUND',
          status: verification.state === 'reversed' ? 'REVERSED' : 'SUCCEEDED',
          amountMinor: amount,
          amountDeltaMinor: targetAmountDelta,
          currency: verification.currency?.toUpperCase() ?? fresh.currency,
          creditDelta: targetCreditDelta,
          ledgerRevision: creditMovement === 0 ? adjustment.ledgerRevision : ledgerRevision,
          appliedAt: new Date(),
          failureReason: verification.reason ?? null,
          payload: adjustmentProviderPayload(adjustment.payload, verification, {
            economicReversalOfProviderRef: separateReverseAction ? matchingCounterpart?.providerRef : undefined,
            economicReversalOfAction: separateReverseAction ?? undefined,
            economicReversedByProviderRef:
              reversalMode === 'separate_adjustment' && !separateReverseAction && verification.state === 'reversed'
                ? matchingCounterpart?.providerRef
                : undefined,
          }),
        },
      });
      if (matchingCounterpart && reversalMode === 'separate_adjustment') {
        const counterpartMetadata = adjustmentProviderMetadata(matchingCounterpart.payload);
        await tx.paymentAdjustment.update({
          where: { id: matchingCounterpart.id },
          data: {
            payload: adjustmentProviderPayload(
              matchingCounterpart.payload,
              {
                providerAction: counterpartMetadata.providerAction,
                reversalMode: counterpartMetadata.reversalMode,
              },
              separateReverseAction
                ? { economicReversedByProviderRef: adjustmentRef }
                : { economicReversalOfProviderRef: adjustmentRef, economicReversalOfAction: providerAction ?? undefined },
            ),
          },
        });
      }
      // A provider may describe the same reversal twice: once as a new
      // reverse adjustment and again by changing the original adjustment's
      // status. Persist that provider fact, but do not let an unrelated second
      // envelope rewrite Payment/Subscription state when the signed aggregate
      // did not move. An exactly bound refund cycle still continues below so
      // it is terminalized rather than left PROCESSING/APPROVED indefinitely.
      if (verification.state === 'reversed' && amountMovement === 0 && creditMovement === 0 && !boundCycle) return 'refund_reversed';
      const aggregate = await tx.paymentAdjustment.aggregate({
        where: { paymentId: fresh.id, status: { in: ['SUCCEEDED', 'REVERSED'] } },
        _sum: { amountDeltaMinor: true, creditDelta: true },
      });
      const netAmount = aggregate._sum.amountDeltaMinor ?? 0;
      const overReturned = netAmount < -fresh.amountMinor;
      const fullyReturned = netAmount === -fresh.amountMinor;
      const partial = netAmount < 0 && !fullyReturned && !overReturned;
      if (overReturned) {
        logger.error(
          {
            paymentId: fresh.id,
            provider: fresh.provider,
            adjustmentRef,
            chargedAmountMinor: fresh.amountMinor,
            netAdjustmentMinor: netAmount,
            currency: fresh.currency,
          },
          'PAYMENT ADJUSTMENT OVER-RETURN NEEDS REVIEW',
        );
      }
      const duplicateInvoice = Boolean(invoice && invoiceSettlementConflicts(invoice, fresh));
      if (fresh.subscriptionId) {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "subscriptions" WHERE "id" = CAST(${fresh.subscriptionId} AS uuid) FOR UPDATE
        `;
      }
      const linkedSubscription = fresh.subscriptionId ? await tx.subscription.findUnique({ where: { id: fresh.subscriptionId } }) : null;
      const otherSubscriptionPaymentRows = linkedSubscription
        ? await tx.payment.findMany({
            where: {
              subscriptionId: linkedSubscription.id,
              kind: { in: ['SUBSCRIPTION', 'RENEWAL'] },
              id: { not: fresh.id },
              // Fulfilment is immutable even when a later partial adjustment
              // changes mutable Payment.status to NEEDS_REVIEW.
              ledgerEntryId: { not: null },
            },
            select: {
              providerPayload: true,
              amountMinor: true,
              adjustments: {
                where: { status: { in: ['SUCCEEDED', 'REVERSED'] } },
                select: { amountDeltaMinor: true },
              },
            },
          })
        : [];
      const otherSubscriptionPayments = otherSubscriptionPaymentRows
        .filter((candidate) => candidate.adjustments.reduce((sum, row) => sum + row.amountDeltaMinor, 0) > -candidate.amountMinor)
        .map((candidate) => ({ providerPayload: candidate.providerPayload }));
      const adjustmentOwnsCurrentPeriod = linkedSubscription
        ? paymentOwnsCurrentSubscriptionPeriod(fresh, linkedSubscription, otherSubscriptionPayments)
        : false;
      const containedAutomaticRefund =
        automaticRefundContainment(fresh.providerPayload) !== null ||
        Boolean(boundCycle && request?.id === boundCycle.requestId && request.requestedById === null && request.reason.startsWith('Automatic recovery:'));
      // Adjustment webhooks may arrive before the transaction webhook. Net
      // zero is not evidence that a PENDING/FAILED checkout was ever fulfilled;
      // promoting it to SUCCEEDED here would make settle() ignore the later
      // charge and leave the customer without credits or a subscription.
      const invoiceFulfilled = Boolean(
        invoice?.status === 'PAID' &&
        (invoice.paymentId === fresh.id || invoice.paymentId === null) &&
        invoice.paidVia === fresh.provider &&
        invoice.paidReference === fresh.providerRef,
      );
      const fulfilled = fresh.ledgerEntryId !== null || fundedCredits > 0 || invoiceFulfilled;
      const reversedEarlyAdjustmentOnly =
        verification.state === 'reversed' &&
        netAmount === 0 &&
        !fulfilled &&
        fresh.status === 'NEEDS_REVIEW' &&
        fresh.failureReason?.startsWith('Partial provider adjustment:');
      const unfulfilledStatus = reversedEarlyAdjustmentOnly
        ? 'PENDING'
        : fresh.status === 'FAILED' || fresh.status === 'NEEDS_REVIEW'
          ? fresh.status
          : 'PENDING';
      // A refund/chargeback cancellation may already have been sent to the
      // provider. If that adjustment reverses, restoring credits while the
      // subscription remains cancelled would retain money without service.
      // Contain it by sending the money back again instead of pretending the
      // subscription can be atomically resurrected.
      const subscriptionReversalContained =
        verification.state === 'reversed' &&
        Boolean(linkedSubscription && (linkedSubscription.status === 'CANCELLED' || linkedSubscription.providerCancelPending));
      const containmentReversed = (containedAutomaticRefund || subscriptionReversalContained) && verification.state === 'reversed';
      // Gateways only expose a full-payment refund command here. If another
      // adjustment remains partially successful, queuing that full command
      // would over-return the charge. Leave the remainder for review instead.
      const queueContainmentRefund = containmentReversed && netAmount === 0;
      const paymentStatus = containmentReversed
        ? 'NEEDS_REVIEW'
        : overReturned
          ? 'NEEDS_REVIEW'
          : fullyReturned
            ? 'REFUNDED'
            : partial || duplicateInvoice || netAmount > 0
              ? 'NEEDS_REVIEW'
              : fulfilled
                ? 'SUCCEEDED'
                : unfulfilledStatus;
      await tx.payment.update({
        where: { id: fresh.id },
        data: {
          status: paymentStatus,
          refundedAt: fullyReturned && !containmentReversed ? new Date() : null,
          providerPayload:
            subscriptionReversalContained && queueContainmentRefund
              ? automaticRefundProviderPayload(
                  fresh.providerPayload,
                  { adjustmentRef, state: verification.state },
                  'A reversed adjustment left its subscription cancelled; return the restored payment',
                )
              : undefined,
          failureReason: containmentReversed
            ? queueContainmentRefund
              ? 'automatic refund was reversed by the provider; another full refund is queued'
              : 'an adjustment reversal left a partial return; manual review is required before any further refund'
            : overReturned
              ? `Provider adjustments exceed the original charge: ${Math.abs(netAmount)} of ${fresh.amountMinor} ${fresh.currency}`
              : fullyReturned
                ? reason === 'chargeback'
                  ? 'gateway chargeback confirmed'
                  : null
                : partial
                  ? `Partial provider adjustment: ${Math.abs(netAmount)} of ${fresh.amountMinor} ${fresh.currency}`
                  : duplicateInvoice
                    ? `Duplicate invoice payment ${fresh.id} requires review`
                    : reversedEarlyAdjustmentOnly
                      ? null
                      : verification.state === 'reversed'
                        ? 'gateway refund/chargeback reversed'
                        : fresh.failureReason,
        },
      });

      if (invoice && invoice.paymentId === fresh.id && !duplicateInvoice) {
        if (fullyReturned && !fulfilled) {
          // The provider returned an adjustment before the charge ever
          // fulfilled. Release this checkout reservation so the still-open
          // invoice can be paid again. A late charge may rebind only if no
          // newer payment claimed it in the meantime.
          await tx.invoice.updateMany({ where: { id: invoice.id, paymentId: fresh.id }, data: { paymentId: null } });
        } else {
          const invoiceStatus = !fulfilled ? invoice.status : fullyReturned && reason === 'refund' ? 'REFUNDED' : netAmount < 0 ? 'DISPUTED' : 'PAID';
          await tx.invoice.update({
            where: { id: invoice.id },
            data: {
              // An adjustment can precede transaction completion. Until this
              // invoice has actual settlement evidence, keep its payable state.
              status: invoiceStatus,
            },
          });
          if (fulfilled && (invoiceStatus === 'DISPUTED' || invoiceStatus === 'REFUNDED')) {
            const now = new Date();
            await tx.billingAccount.updateMany({
              where: { id: invoice.accountId, status: 'ACTIVE' },
              data: {
                status: 'SUSPENDED',
                suspendedAt: now,
                suspendedReason: `invoice adjustment: ${invoice.number}`,
              },
            });
            await tx.wallet.update({ where: { id: wallet.id }, data: { overdraftLimit: 0 } });
          } else if (fulfilled && invoiceStatus === 'PAID' && verification.state === 'reversed' && netAmount === 0) {
            const account = await tx.billingAccount.findUnique({ where: { id: invoice.accountId } });
            if (account?.status === 'SUSPENDED') {
              const blockers = await tx.invoice.count({
                where: { accountId: account.id, status: { in: ['OVERDUE', 'DISPUTED', 'REFUNDED'] } },
              });
              if (blockers === 0) {
                const reactivated = await tx.billingAccount.updateMany({
                  where: { id: account.id, status: 'SUSPENDED' },
                  data: { status: 'ACTIVE', suspendedAt: null, suspendedReason: null },
                });
                if (reactivated.count === 1) {
                  await tx.wallet.update({ where: { id: wallet.id }, data: { overdraftLimit: account.creditLimit } });
                }
              }
            }
          }
        }
      }
      // A won/reversed chargeback restores the payment. It must not cancel a
      // healthy subscription merely because the webhook is still classified
      // as a chargeback event. Only value that is currently withheld can make
      // an active dispute terminal locally.
      const activeChargeback = reason === 'chargeback' && verification.state === 'succeeded' && netAmount < 0;
      if (fresh.subscriptionId && fulfilled && adjustmentOwnsCurrentPeriod && (fullyReturned || overReturned || activeChargeback)) {
        await tx.subscription.update({
          where: { id: fresh.subscriptionId },
          data: {
            status: 'CANCELLED',
            cancelAtPeriodEnd: false,
            cancelledAt: new Date(),
            providerCancelPending: true,
            providerCancelAttempts: 0,
            providerCancelNextAt: new Date(),
            providerCancelError: null,
          },
        });
      } else if (fresh.subscriptionId && fulfilled && !adjustmentOwnsCurrentPeriod && (fullyReturned || overReturned || activeChargeback)) {
        logger.info(
          { paymentId: fresh.id, subscriptionId: fresh.subscriptionId },
          'adjustment for an older subscription period did not cancel the current subscription',
        );
      }
      if (queueContainmentRefund) {
        const now = new Date();
        const containmentReason = subscriptionReversalContained
          ? 'Automatic recovery: a reversed adjustment left the subscription cancelled'
          : 'Automatic recovery: provider reversed the prior automatic refund';
        const containmentRequest = await tx.refundRequest.upsert({
          where: { paymentId: fresh.id },
          create: {
            paymentId: fresh.id,
            workspaceId: fresh.workspaceId,
            requestedById: null,
            reason: containmentReason,
            status: 'PROCESSING',
            balanceAtRequest: 0,
            decidedAt: now,
            decisionNote: 'The prior adjustment was reversed; another full refund is queued.',
            processingAt: null,
            nextAttemptAt: now,
            refundCycle: 1,
          },
          update: {
            requestedById: null,
            reason: containmentReason,
            status: 'PROCESSING',
            refundCycle: { increment: 1 },
            gatewayRef: null,
            processingAt: null,
            attempts: 0,
            decidedAt: now,
            decidedById: null,
            decisionNote: 'The prior adjustment was reversed; another full refund is queued.',
            lastError: null,
            nextAttemptAt: now,
          },
        });
        if (fundedCredits > 0) {
          // The reversal and the replacement automatic refund are one
          // economic transition. At net money zero every originally funded
          // credit is available again, including credits restored by earlier
          // partial reversals. Reserve that whole funded amount before the
          // wallet lock is released so none can be spent while the replacement
          // full refund is in flight.
          await this.ledger.forceClawback(
            {
              walletId: wallet.id,
              amount: fundedCredits,
              idempotencyKey: refundReservationKey(containmentRequest.id, containmentRequest.refundCycle),
              referenceId: fresh.id,
              reason: `Credits reserved while ${fresh.provider} retries a reversed automatic refund of ${fresh.itemCode}`,
            },
            tx,
          );
        }
      } else {
        if (boundCycle)
          await tx.refundRequest.updateMany({
            where: {
              id: boundCycle.requestId,
              paymentId: fresh.id,
              refundCycle: boundCycle.refundCycle,
              status: { in: ['REQUESTED', 'PROCESSING', 'APPROVED', 'NEEDS_REVIEW', 'REFUSED', 'CANCELLED'] },
            },
            data: {
              status: fullyReturned ? 'APPROVED' : 'NEEDS_REVIEW',
              gatewayRef: adjustmentRef,
              decisionNote: fullyReturned
                ? adjustmentRef
                : overReturned
                  ? 'Provider adjustments exceed the original charge; support review is required.'
                  : verification.state === 'reversed'
                    ? 'The payment provider reversed all or part of the adjustment; support review is required.'
                    : 'The payment provider returned only part of the charge; support review is required.',
              lastError: fullyReturned ? null : 'provider adjustment requires review',
              nextAttemptAt: null,
            },
          });
      }
      if (overReturned) return 'adjustment_needs_review';
      if (fullyReturned) return reason === 'chargeback' ? 'chargeback_confirmed' : 'refunded';
      if (verification.state === 'reversed') return 'refund_reversed';
      return partial ? 'partial_adjustment_recorded' : 'adjustment_recorded';
    });
  }

  private async reconcilePendingRefunds(now: Date): Promise<{ checked: number; completed: number; failed: number }> {
    const rows = await this.db.refundRequest.findMany({
      where: { status: 'PROCESSING', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      include: { payment: true },
      orderBy: { processingAt: 'asc' },
      take: 25,
    });
    let checked = 0;
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      const claimed = await this.db.refundRequest.updateMany({
        where: {
          id: row.id,
          status: 'PROCESSING',
          attempts: row.attempts,
          nextAttemptAt: row.nextAttemptAt,
          processingAt: row.processingAt,
          refundCycle: row.refundCycle,
        },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(now.getTime() + REFUND_RECHECK_MS),
        },
      });
      if (claimed.count === 0) continue;
      checked += 1;
      if (row.attempts + 1 >= REFUND_MAX_ATTEMPTS) {
        const failure = REFUND_RECONCILIATION_EXHAUSTED;
        const marked = await this.db.$transaction(async (tx) => {
          // Same lock order as adjustment finalisation: Payment, then request.
          // A signed webhook that already confirmed the refund wins cleanly;
          // this stale exhaustion pass must not overwrite REFUNDED/APPROVED.
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "payments" WHERE "id" = CAST(${row.paymentId} AS uuid) FOR UPDATE
          `;
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "refund_requests" WHERE "id" = CAST(${row.id} AS uuid) FOR UPDATE
          `;
          const current = await tx.refundRequest.findUnique({ where: { id: row.id }, select: { status: true, attempts: true, refundCycle: true } });
          const payment = await tx.payment.findUnique({ where: { id: row.paymentId }, select: { status: true } });
          if (
            !current ||
            !payment ||
            current.status !== 'PROCESSING' ||
            current.attempts !== row.attempts + 1 ||
            current.refundCycle !== row.refundCycle ||
            payment.status === 'REFUNDED'
          )
            return false;
          const request = await tx.refundRequest.updateMany({
            where: { id: row.id, status: 'PROCESSING', attempts: row.attempts + 1, refundCycle: row.refundCycle },
            data: { status: 'NEEDS_REVIEW', lastError: failure, decisionNote: failure, nextAttemptAt: null },
          });
          if (request.count !== 1) return false;
          await tx.payment.updateMany({
            where: { id: row.paymentId, status: { not: 'REFUNDED' } },
            data: { status: 'NEEDS_REVIEW', failureReason: failure },
          });
          return true;
        });
        if (marked) {
          failed += 1;
          logger.error({ requestId: row.id, paymentId: row.paymentId, attempts: row.attempts + 1 }, 'REFUND NEEDS REVIEW: reconciliation exhausted');
        }
        continue;
      }
      const gateway = this.gateways.get(row.payment.provider);
      if (!gateway) {
        failed += 1;
        await this.db.refundRequest.updateMany({
          where: { id: row.id, status: 'PROCESSING', attempts: row.attempts + 1, refundCycle: row.refundCycle },
          data: { lastError: 'payment gateway is not configured' },
        });
        continue;
      }
      try {
        let verification: RefundVerification;
        let verifiedPayment = row.payment;
        if (row.gatewayRef) {
          verification = await gateway.verifyRefund(row.payment, row.gatewayRef ?? undefined);
          if (verification.providerRef && verification.providerRef !== row.gatewayRef) {
            await this.db.refundRequest.updateMany({
              where: { id: row.id, status: 'PROCESSING', attempts: row.attempts + 1, refundCycle: row.refundCycle },
              data: { gatewayRef: verification.providerRef },
            });
          }
        } else {
          const submitted = await this.submitRefundCycle(gateway, {
            paymentId: row.paymentId,
            requestId: row.id,
            refundCycle: row.refundCycle,
            expectedAttempts: row.attempts + 1,
            since: row.decidedAt ?? row.createdAt,
            reason: row.reason,
            requireUnclaimed: false,
          });
          if (!submitted) continue;
          verification = submitted.verification;
          verifiedPayment = submitted.payment;
        }
        const outcome = await this.applyRefundVerification(verifiedPayment, verification, 'refund', {
          requestId: row.id,
          refundCycle: row.refundCycle,
        });
        if (outcome === 'refunded' || outcome === 'chargeback_confirmed') completed += 1;
      } catch (err) {
        failed += 1;
        const error = err instanceof Error ? err.message : String(err);
        await this.db.refundRequest.updateMany({
          where: { id: row.id, status: 'PROCESSING', attempts: row.attempts + 1, refundCycle: row.refundCycle },
          data: { lastError: error },
        });
        logger.error({ err, requestId: row.id, paymentId: row.paymentId }, 'refund reconciliation failed');
      }
    }
    return { checked, completed, failed };
  }

  private async submitRefundCycle(
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
  ): Promise<{ payment: Payment; verification: RefundVerification } | null> {
    return this.db.$transaction(
      async (tx) => {
        // There is no provider idempotency key shared end-to-end with either
        // adapter. Keep the same Payment -> RefundRequest lock order used by
        // adjustment finalization and hold both rows through the last provider
        // discovery, the refund call, and durable response recording. A webhook
        // that started first wins and makes this a no-op; one that starts later
        // waits and then observes the recorded provider reference.
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "payments" WHERE "id" = CAST(${input.paymentId} AS uuid) FOR UPDATE
        `;
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "refund_requests" WHERE "id" = CAST(${input.requestId} AS uuid) FOR UPDATE
        `;
        const request = await tx.refundRequest.findUnique({ where: { id: input.requestId } });
        if (
          !request ||
          request.paymentId !== input.paymentId ||
          request.status !== 'PROCESSING' ||
          request.refundCycle !== input.refundCycle ||
          request.attempts !== input.expectedAttempts ||
          request.gatewayRef !== null ||
          (input.requireUnclaimed && request.processingAt !== null)
        ) {
          return null;
        }
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
        const context = await this.refundDiscoveryContext(input.paymentId, input.since, input.refundCycle, tx);
        const observed = await gateway.discoverRefund(payment, context);
        const verification = observed.providerRef || observed.state !== 'pending' ? observed : await gateway.refund(payment, input.reason, context);
        await tx.refundRequest.update({
          where: { id: request.id },
          data: {
            gatewayRef: verification.providerRef,
            processingAt: request.processingAt ?? new Date(),
            lastError: null,
          },
        });
        return { payment, verification };
      },
      // Each adapter may perform discovery plus more than one 20-second HTTP
      // request. The long timeout is intentional: releasing these row locks
      // before recording the response recreates a double-refund TOCTOU.
      { maxWait: 10_000, timeout: 120_000 },
    );
  }

  private async refundDiscoveryContext(
    paymentId: string,
    since: Date,
    refundCycle: number,
    client: Pick<Prisma.TransactionClient, 'paymentAdjustment'> = this.db,
  ) {
    const adjustments = await client.paymentAdjustment.findMany({
      where: {
        paymentId,
        OR: [
          { refundCycle: { not: null, notIn: [refundCycle] } },
          // Legacy/unsolicited rows from before this cycle are not its
          // acknowledgement. Recent unbound rows stay discoverable so a
          // response-lost POST followed by a webhook can be adopted safely.
          { refundCycle: null, createdAt: { lt: new Date(since.getTime() - 30_000) } },
        ],
      },
      select: { providerRef: true },
    });
    return { excludeProviderRefs: adjustments.map((row) => row.providerRef), since };
  }

  private async reconcileProviderCancellations(now: Date): Promise<{ completed: number; failed: number }> {
    const rows = await this.db.subscription.findMany({
      where: { providerCancelPending: true, OR: [{ providerCancelNextAt: null }, { providerCancelNextAt: { lte: now } }] },
      orderBy: { providerCancelNextAt: 'asc' },
      take: 25,
    });
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      const claimed = await this.db.subscription.updateMany({
        where: {
          id: row.id,
          providerCancelPending: true,
          providerCancelAttempts: row.providerCancelAttempts,
          providerCancelNextAt: row.providerCancelNextAt,
        },
        data: { providerCancelAttempts: { increment: 1 }, providerCancelNextAt: new Date(now.getTime() + refundBackoff(row.providerCancelAttempts + 1)) },
      });
      if (claimed.count === 0) continue;
      const gateway = this.gateways.get(row.provider);
      if (!gateway || !row.providerRef) {
        failed += 1;
        await this.db.subscription.update({
          where: { id: row.id },
          data: { providerCancelError: !gateway ? 'payment gateway is not configured' : 'provider subscription id is missing' },
        });
        continue;
      }
      try {
        const providerRef = await this.resolveCancellationReference(row, gateway);
        await gateway.cancelSubscription({
          providerRef,
          customerRef: row.customerRef ?? undefined,
          catalogueRef: row.catalogueRef ?? undefined,
          // A customer request keeps service through its paid period. A
          // refund/chargeback makes the local row terminal and cancels now.
          atPeriodEnd: row.status !== 'CANCELLED' && row.cancelAtPeriodEnd,
        });
        await this.db.subscription.updateMany({
          // Do not clear a newer immediate-cancel command if a chargeback raced
          // an in-flight end-of-period request.
          where: {
            id: row.id,
            providerCancelPending: true,
            status: row.status,
            cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          },
          data: { providerCancelPending: false, providerCancelNextAt: null, providerCancelError: null },
        });
        completed += 1;
      } catch (err) {
        failed += 1;
        const error = err instanceof Error ? err.message : String(err);
        await this.db.subscription.update({ where: { id: row.id }, data: { providerCancelError: error } });
        logger.error({ err, subscriptionId: row.id, provider: row.provider }, 'provider subscription cancellation will retry');
      }
    }
    return { completed, failed };
  }

  /** Upgrade a legacy Flutterwave plan id to the exact customer subscription. */
  private async resolveCancellationReference(sub: Subscription, gateway: Gateway): Promise<string> {
    if (sub.provider === 'FLUTTERWAVE' && sub.providerRef && sub.catalogueRef && sub.providerRef === sub.catalogueRef && gateway.resolveSubscriptionRef) {
      const original = await this.db.payment.findFirst({
        where: {
          subscriptionId: sub.id,
          provider: sub.provider,
          kind: 'SUBSCRIPTION',
          // Refund/chargeback state is mutable; this pointer is immutable
          // evidence that the original subscription value was delivered.
          ledgerEntryId: { not: null },
          providerRef: { not: null },
        },
        orderBy: { createdAt: 'asc' },
        select: { providerRef: true },
      });
      if (original?.providerRef) {
        const resolved = await gateway.resolveSubscriptionRef(original.providerRef);
        if (resolved) {
          await this.db.subscription.updateMany({
            where: { id: sub.id, providerRef: sub.providerRef },
            data: { providerRef: resolved },
          });
          return resolved;
        }
      }
    }
    if (!sub.providerRef) throw new Error('provider subscription id is missing');
    return sub.providerRef;
  }

  /**
   * A charge we have no row for, on a subscription we do: the gateway
   * renewed it. Write the RENEWAL row so the settlement path is the same one
   * a first purchase takes.
   */
  private async renewalPayment(provider: PaymentProvider, intent: Extract<WebhookIntent, { kind: 'charge' }>): Promise<Payment | null> {
    // Without the gateway transaction id there is nothing authoritative to
    // re-fetch, and therefore no safe renewal to grant or record as failed.
    if (!intent.providerRef) return null;
    const where: Prisma.SubscriptionWhereInput = { provider };
    if (intent.subscriptionRef) {
      // A provider can charge after local cancellation raced its final retry.
      // The immutable provider subscription id still identifies that money;
      // record it and let settle() queue the automatic refund.
      where.providerRef = intent.subscriptionRef;
    } else if (intent.planRef && intent.customerEmail) {
      where.catalogueRef = intent.planRef;
      where.customerRef = intent.customerEmail;
      where.status = { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] };
    } else if (intent.customerEmail) {
      // Some Flutterwave renewal payloads omit the plan entirely. Email is
      // safe only when it identifies exactly one live subscription; choosing
      // an arbitrary workspace would grant somebody else's credits.
      where.customerRef = intent.customerEmail;
      where.status = { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] };
      const matches = await this.db.subscription.findMany({ where, take: 2 });
      if (matches.length !== 1) {
        logger.error({ provider, customerEmail: intent.customerEmail, matches: matches.length }, 'renewal customer did not identify exactly one subscription');
        return null;
      }
      where.id = matches[0]!.id;
    } else return null;
    let matches = await this.db.subscription.findMany({ where, orderBy: { createdAt: 'desc' }, take: 2 });
    // Migration 00000 retained the old Flutterwave representation where
    // providerRef was the shared plan id. Once verification resolves this
    // transaction to the customer's real subscription id, upgrade exactly one
    // live plan+email match under lock. Ambiguity is never guessed through.
    if (matches.length === 0 && provider === 'FLUTTERWAVE' && intent.subscriptionRef && intent.planRef && intent.customerEmail) {
      const legacy = await this.db.subscription.findMany({
        where: {
          provider,
          providerRef: intent.planRef,
          catalogueRef: intent.planRef,
          customerRef: intent.customerEmail,
          status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      if (legacy.length === 1) {
        const candidate = legacy[0]!;
        const upgraded = await this.db.$transaction(async (tx) => {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "workspaces" WHERE "id" = CAST(${candidate.workspaceId} AS uuid) FOR UPDATE
          `;
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "subscriptions" WHERE "id" = CAST(${candidate.id} AS uuid) FOR UPDATE
          `;
          const fresh = await tx.subscription.findUnique({ where: { id: candidate.id } });
          if (fresh?.provider === provider && fresh.providerRef === intent.subscriptionRef) return fresh;
          if (
            !fresh ||
            fresh.provider !== provider ||
            fresh.providerRef !== intent.planRef ||
            fresh.catalogueRef !== intent.planRef ||
            fresh.customerRef !== intent.customerEmail ||
            !['ACTIVE', 'PAST_DUE', 'PAUSED'].includes(fresh.status)
          ) {
            return null;
          }
          return tx.subscription.update({ where: { id: fresh.id }, data: { providerRef: intent.subscriptionRef } });
        });
        if (upgraded) matches = [upgraded];
      } else if (legacy.length > 1) {
        logger.error(
          { provider, planRef: intent.planRef, customerEmail: intent.customerEmail, matches: legacy.length },
          'legacy renewal identity matched multiple subscriptions; refusing arbitrary migration',
        );
      }
    }
    if (matches.length !== 1) {
      if (matches.length > 1) {
        logger.error(
          { provider, subscriptionRef: intent.subscriptionRef, planRef: intent.planRef, customerEmail: intent.customerEmail },
          'renewal identity matched multiple subscriptions; refusing arbitrary credit allocation',
        );
      }
      return null;
    }
    const sub = matches[0]!;
    // The first paid row is the immutable commercial agreement. Workspace
    // currency and catalogue prices may change later; neither may rewrite a
    // live provider subscription's renewal expectation.
    const original = await this.db.payment.findFirst({
      where: {
        subscriptionId: sub.id,
        kind: 'SUBSCRIPTION',
        // A partial adjustment changes status to NEEDS_REVIEW but does not
        // erase the commercial agreement or the provider transaction that
        // identifies future renewals.
        ledgerEntryId: { not: null },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!original) {
      logger.error({ subscriptionId: sub.id, workspaceId: sub.workspaceId, provider }, 'renewal could not find the original paid subscription row');
      return null;
    }
    let payment: Payment;
    try {
      payment = await this.db.payment.create({
        data: {
          workspaceId: sub.workspaceId,
          provider,
          kind: 'RENEWAL',
          reference: `as_renew_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`,
          providerRef: intent.providerRef,
          itemCode: sub.planCode,
          interval: sub.interval,
          credits: original.credits,
          amountMinor: original.amountMinor,
          currency: original.currency,
          subscriptionId: sub.id,
          providerPayload: {
            subscriptionRef: sub.providerRef,
            customerRef: sub.customerRef,
            catalogueRef: providerContext(original.providerPayload).catalogueRef,
          },
        },
      });
    } catch (err) {
      // Paddle may deliver `transaction.paid` and `transaction.completed`
      // concurrently for the same transaction. The database unique key is
      // the final authority; the loser continues with the row already made.
      if (intent.providerRef && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.db.payment.findFirst({ where: { provider, providerRef: intent.providerRef } });
        if (existing) return existing;
      }
      throw err;
    }
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
    const requestedAt = new Date();
    const sub = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "workspaces" WHERE "id" = CAST(${workspaceId} AS uuid) FOR UPDATE
      `;
      const current = await tx.subscription.findFirst({
        where: { workspaceId, status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!current) throw new NotFoundError('subscription');
      if (current.cancelAtPeriodEnd && !current.providerCancelPending) return current;
      // Save the command before the external request. A crash or network
      // timeout can now only delay cancellation; maintenance will retry it.
      return tx.subscription.update({
        where: { id: current.id },
        data: {
          cancelAtPeriodEnd: true,
          cancelledAt: current.cancelledAt ?? requestedAt,
          providerCancelPending: true,
          providerCancelAttempts: 0,
          providerCancelNextAt: requestedAt,
          providerCancelError: null,
        },
      });
    });
    if (sub.providerCancelPending) {
      const gateway = this.gateways.get(sub.provider);
      if (!gateway || !sub.providerRef) {
        const error = !gateway ? 'payment gateway is not configured' : 'provider subscription id is missing';
        await this.db.subscription.update({ where: { id: sub.id }, data: { providerCancelError: error } });
        logger.error({ subscriptionId: sub.id, provider: sub.provider, error }, 'subscription cancellation saved for retry');
      } else {
        try {
          const providerRef = await this.resolveCancellationReference(sub, gateway);
          await gateway.cancelSubscription({
            providerRef,
            customerRef: sub.customerRef ?? undefined,
            catalogueRef: sub.catalogueRef ?? undefined,
            atPeriodEnd: true,
          });
          await this.db.subscription.updateMany({
            where: { id: sub.id, providerCancelPending: true, status: sub.status, cancelAtPeriodEnd: true },
            data: { providerCancelPending: false, providerCancelNextAt: null, providerCancelError: null },
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await this.db.subscription.update({
            where: { id: sub.id },
            data: { providerCancelError: error, providerCancelNextAt: new Date(requestedAt.getTime() + refundBackoff(1)) },
          });
          logger.error({ err, subscriptionId: sub.id, provider: sub.provider }, 'subscription cancellation saved for retry');
        }
      }
    }
    const updated = await this.db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    authLog(
      'billing.cancel',
      'succeeded',
      {
        userId: actor.userId,
        workspaceId,
        subscriptionId: sub.id,
        provider: sub.provider,
        providerPending: updated.providerCancelPending,
      },
      req,
    );
    return this.subscriptionView(updated);
  }

  // ---------------------------------------------------------------- refunds

  /**
   * Whether a purchase can be asked back: paid, recent, and the credits
   * still there. The same test the request endpoint applies, exposed so
   * the payments table can show the button only when it would work.
   */
  async refundEligibility(payment: Payment, balance: number): Promise<{ ok: boolean; why?: string }> {
    if (payment.status !== 'SUCCEEDED') return { ok: false, why: 'Only a paid purchase can be refunded.' };
    if (payment.kind === 'INVOICE') return { ok: false, why: 'Invoices are settled with the studio directly.' };
    if (payment.kind !== 'PACK') return { ok: false, why: 'A plan is cancelled from the Credits page; it runs to the end of the paid period.' };
    if (Date.now() - payment.createdAt.getTime() > REFUND_WINDOW_DAYS * 86_400_000)
      return { ok: false, why: `Refunds are possible within ${REFUND_WINDOW_DAYS} days of a purchase.` };
    if (balance < payment.credits) return { ok: false, why: 'Some of these credits have been used, so the purchase cannot be refunded.' };
    return { ok: true };
  }

  /** The customer asks. Nothing moves yet; staff decide, and the credits are checked again then. */
  async requestRefund(actor: Actor, workspaceId: string, paymentId: string, dto: RefundRequestDto, req: Request) {
    this.assertBuyer(actor, workspaceId);
    const { payment, request, balance } = await this.db.$transaction(async (tx) => {
      // A system-created recovery and two customer tabs can all target the
      // one-to-one RefundRequest row. Serialize on Payment so a losing request
      // gets a business conflict instead of a P2002 or overwriting recovery.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "payments" WHERE "id" = CAST(${paymentId} AS uuid) FOR UPDATE
      `;
      const locked = await tx.payment.findFirst({ where: { id: paymentId, workspaceId }, include: { refundRequest: true } });
      if (!locked) throw new NotFoundError('payment');
      if (locked.refundRequest && ['REQUESTED', 'PROCESSING', 'NEEDS_REVIEW'].includes(locked.refundRequest.status))
        throw new ConflictError('A refund is already being looked at for this purchase.');
      if (locked.refundRequest?.status === 'APPROVED') throw new ConflictError('This purchase was already refunded.');
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { workspaceId }, select: { id: true } });
      const [balanceRow] = await tx.$queryRaw<Array<{ balance: number }>>`
        SELECT ledger_balance(${wallet.id}::uuid) AS balance
      `;
      const balance = Number(balanceRow?.balance ?? 0);
      const eligibility = await this.refundEligibility(locked, balance);
      if (!eligibility.ok) throw new ConflictError(eligibility.why!);
      const data = {
        workspaceId,
        requestedById: actor.userId,
        reason: dto.reason.trim(),
        status: 'REQUESTED' as const,
        balanceAtRequest: balance,
        decidedAt: null,
        decidedById: null,
        decisionNote: null,
        gatewayRef: null,
        processingAt: null,
        nextAttemptAt: null,
        attempts: 0,
        lastError: null,
      };
      const request = locked.refundRequest
        ? await tx.refundRequest.update({
            where: { id: locked.refundRequest.id },
            data: { ...data, refundCycle: { increment: 1 } },
          })
        : await tx.refundRequest.create({ data: { paymentId: locked.id, refundCycle: 1, ...data } });
      return { payment: locked, request, balance };
    });
    authLog(
      'billing.refund',
      'succeeded',
      {
        userId: actor.userId,
        workspaceId,
        paymentId,
        requestId: request.id,
        credits: payment.credits,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      },
      req,
    );
    logger.info({ requestId: request.id, paymentId, workspaceId, credits: payment.credits, balance }, 'refund requested');
    const user = await this.db.user.findUnique({ where: { id: actor.userId }, select: { email: true, name: true } });
    if (user?.email) {
      const origin = this.auth.publicOrigin(req);
      await this.mailer
        .send(
          refundRequested(user.email, user.name, {
            item: itemWords(payment),
            amount: money(payment.amountMinor, payment.currency),
            reference: payment.reference,
            url: `${origin}/billing`,
          }),
        )
        .catch((err: unknown) => logger.error({ err, requestId: request.id }, 'refund request mail failed'));
    }
    const alert = process.env.REFUNDS_EMAIL?.trim();
    if (alert)
      await this.mailer
        .send({
          to: alert,
          subject: `Refund request: ${money(payment.amountMinor, payment.currency)} · ${payment.reference}`,
          text: `Workspace ${workspaceId}\nPayment ${payment.id} (${payment.reference}) ${itemWords(payment)} ${money(payment.amountMinor, payment.currency)}\nCredits ${payment.credits}, balance now ${balance}\nReason: ${dto.reason.trim()}\n\nDecide in the staff console → Payments.`,
        })
        .catch((err: unknown) => logger.error({ err, requestId: request.id }, 'refund alert mail failed'));
    return this.refundView(request);
  }

  async cancelRefundRequest(actor: Actor, workspaceId: string, paymentId: string, req: Request) {
    this.assertBuyer(actor, workspaceId);
    const request = await this.db.refundRequest.findFirst({ where: { paymentId, workspaceId } });
    if (!request) throw new NotFoundError('refund request');
    if (request.status !== 'REQUESTED') throw new ConflictError('That request has already been decided.');
    const cancelled = await this.db.refundRequest.updateMany({
      where: { id: request.id, status: 'REQUESTED' },
      data: { status: 'CANCELLED', decidedAt: new Date() },
    });
    if (cancelled.count === 0) throw new ConflictError('That request has already been claimed for processing.');
    const updated = await this.db.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    authLog('billing.refund', 'succeeded', { userId: actor.userId, workspaceId, paymentId, requestId: request.id, cancelled: true }, req);
    return this.refundView(updated);
  }

  /**
   * Staff approval starts a provider refund. It is not called APPROVED until
   * the adapter independently observes the provider's terminal success;
   * Paddle commonly waits for approval and Flutterwave disburses later.
   */
  async decideRefund(actor: Actor, requestId: string, approve: boolean, note: string, req: Request) {
    const request = await this.db.refundRequest.findUnique({ where: { id: requestId }, include: { payment: true } });
    if (!request) throw new NotFoundError('refund request');
    if (request.status !== 'REQUESTED') throw new ConflictError(`That request is ${request.status.toLowerCase()}.`);
    let payment = request.payment;
    const gateway = this.gateways.get(payment.provider);
    if (approve && !gateway)
      throw new ConflictError(`The ${payment.provider} gateway is not configured here, so the money cannot be sent back from this console.`);
    let decisionNote: string | null = note.trim() || null;
    if (!approve) {
      const claimed = await this.db.refundRequest.updateMany({
        where: { id: requestId, status: 'REQUESTED' },
        data: { status: 'REFUSED', decidedById: actor.userId, decidedAt: new Date(), decisionNote },
      });
      if (claimed.count === 0) throw new ConflictError('That request was just decided by someone else.');
    } else {
      let reserved = false;
      let refundCycle = request.refundCycle;
      const refundCycleStartedAt = new Date();
      try {
        await this.db.$transaction(async (tx) => {
          // Adjustment finalization takes Payment before RefundRequest. Keep
          // the same lock order here so an unsolicited provider refund racing
          // staff approval cannot deadlock or cause a second refund request.
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "payments" WHERE "id" = CAST(${payment.id} AS uuid) FOR UPDATE
          `;
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "refund_requests" WHERE "id" = CAST(${requestId} AS uuid) FOR UPDATE
          `;
          const freshRequest = await tx.refundRequest.findUniqueOrThrow({ where: { id: requestId } });
          if (freshRequest.status !== 'REQUESTED') throw new ConflictError(`That request is ${freshRequest.status.toLowerCase()}.`);
          const freshPayment = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
          if (freshPayment.status !== 'SUCCEEDED') {
            throw new ConflictError(`That payment is ${freshPayment.status.toLowerCase().replace('_', ' ')} and cannot be refunded again.`);
          }
          payment = freshPayment;
          refundCycle = freshRequest.refundCycle;
          const lockedWallet = await tx.wallet.findUniqueOrThrow({ where: { workspaceId: payment.workspaceId }, select: { id: true } });
          const claimed = await tx.refundRequest.updateMany({
            where: { id: requestId, status: 'REQUESTED' },
            data: {
              status: 'PROCESSING',
              decidedById: actor.userId,
              decidedAt: refundCycleStartedAt,
              // Null is the durable outbox state: approved, but no provider
              // response has been observed. Recovery queries provider truth
              // before it ever retries the POST.
              processingAt: null,
              nextAttemptAt: new Date(refundCycleStartedAt.getTime() + REFUND_RECHECK_MS),
              attempts: 0,
              lastError: null,
              decisionNote: 'Awaiting confirmation from the payment provider.',
            },
          });
          if (claimed.count === 0) throw new ConflictError('That request was just decided by someone else.');
          await this.ledger.clawback(
            {
              walletId: lockedWallet.id,
              amount: payment.credits,
              idempotencyKey: refundReservationKey(requestId, freshRequest.refundCycle),
              referenceId: payment.id,
              reason: `Credits reserved while ${payment.provider} processes a refund of ${payment.itemCode}`,
            },
            tx,
          );
        });
        reserved = true;
      } catch (err) {
        if (!(err instanceof InsufficientCreditsError)) throw err;
        decisionNote = 'Some of the credits were used after the request was made, so the purchase can no longer be refunded.';
        const refused = await this.db.refundRequest.updateMany({
          where: { id: requestId, status: 'REQUESTED' },
          data: { status: 'REFUSED', decidedById: actor.userId, decidedAt: new Date(), decisionNote },
        });
        if (refused.count === 0) throw new ConflictError('That request was just decided by someone else.');
      }
      if (reserved) {
        try {
          const submitted = await this.submitRefundCycle(gateway!, {
            paymentId: payment.id,
            requestId,
            refundCycle,
            expectedAttempts: 0,
            since: refundCycleStartedAt,
            reason: note.trim() || 'requested by customer',
            requireUnclaimed: true,
          });
          if (!submitted) {
            logger.info({ requestId, paymentId: payment.id, refundCycle }, 'refund submission skipped because the cycle was already claimed or finalized');
          } else {
            payment = submitted.payment;
            await this.applyRefundVerification(payment, submitted.verification, 'refund', { requestId, refundCycle });
          }
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          // A network timeout is ambiguous: the gateway may have accepted the
          // refund. The provider-call transaction rolls its claim back, so
          // maintenance discovers by transaction before it retries the POST.
          await this.db.refundRequest.updateMany({
            where: { id: requestId, status: 'PROCESSING', refundCycle },
            data: { lastError: error, nextAttemptAt: new Date(Date.now() + REFUND_RECHECK_MS) },
          });
          logger.error({ err: e, requestId, paymentId: payment.id, provider: payment.provider }, 'refund initiation uncertain; reconciliation scheduled');
        }
      }
    }
    const updated = await this.db.refundRequest.findUniqueOrThrow({ where: { id: request.id } });
    const approved = updated.status === 'APPROVED';
    const processing = updated.status === 'PROCESSING';
    decisionNote = updated.decisionNote;
    authLog(
      'billing.refund',
      approved ? 'succeeded' : processing ? 'succeeded' : 'refused',
      { userId: actor.userId, workspaceId: payment.workspaceId, paymentId: payment.id, requestId, approved, processing, note: decisionNote },
      req,
    );
    logger.info(
      { requestId, paymentId: payment.id, status: updated.status, by: actor.userId },
      approved ? 'refund confirmed; credits clawed back' : processing ? 'refund submitted; awaiting provider confirmation' : 'refund refused',
    );
    const user = request.requestedById ? await this.db.user.findUnique({ where: { id: request.requestedById }, select: { email: true, name: true } }) : null;
    if (user?.email && !processing)
      await this.mailer
        .send(
          refundDecided(user.email, user.name, {
            approved,
            item: itemWords(payment),
            amount: money(payment.amountMinor, payment.currency),
            reference: payment.reference,
            note: approved ? null : decisionNote,
            url: `${this.auth.publicOrigin(req)}/billing`,
          }),
        )
        .catch((err: unknown) => logger.error({ err, requestId }, 'refund decision mail failed'));
    if (request.requestedById)
      void this.notifications.notify(request.requestedById, {
        workspaceId: payment.workspaceId,
        kind: 'CREDITS',
        title: approved ? `${money(payment.amountMinor, payment.currency)} refunded` : processing ? 'Your refund is being processed' : 'Your refund request',
        body: approved
          ? 'The payment provider confirmed the refund. The credits have been removed.'
          : processing
            ? 'The payment provider is processing it. We will update this automatically when it is confirmed.'
            : (decisionNote ?? 'It could not be refunded this time.'),
        href: '/billing',
        refId: `refund:${request.id}`,
      });
    return this.refundView(updated);
  }

  async refundRequests(q: RefundsQueryDto) {
    const take = q.take ?? 25;
    const rows = await this.db.refundRequest.findMany({
      where: { status: q.status ?? 'REQUESTED' },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { payment: true, workspace: { select: { id: true, name: true, wallet: { select: { id: true } } } } },
    });
    const page = rows.slice(0, take);
    const out = [];
    for (const r of page) {
      const balance = r.workspace.wallet ? await this.ledger.balance(r.workspace.wallet.id) : 0;
      const requester = r.requestedById ? await this.db.user.findUnique({ where: { id: r.requestedById }, select: { name: true, email: true } }) : null;
      out.push({
        ...this.refundView(r),
        decisionNote: r.decisionNote,
        balanceAtRequest: r.balanceAtRequest,
        balanceNow: balance,
        stillRefundable: balance >= r.payment.credits,
        gatewayConfigured: this.gateways.has(r.payment.provider),
        requester,
        workspace: { id: r.workspace.id, name: r.workspace.name },
        payment: this.paymentView(r.payment),
      });
    }
    return { rows: out, nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null };
  }

  /** The staff gate in front of decideRefund: rank, no self-dealing, a recent second factor. */
  async decideRefundAsStaff(actor: Actor, requestId: string, approve: boolean, note: string, req: Request) {
    const request = await this.db.refundRequest.findUnique({ where: { id: requestId }, select: { workspaceId: true } });
    if (!request) throw new NotFoundError('refund request');
    assertStaffMutation(actor, { min: 'OPERATOR', workspaceId: request.workspaceId, stepUpMinutes: 30 });
    if (!approve && note.trim().length < 4) throw new ValidationError({ note: 'Say why, in a sentence the customer will read.' });
    return this.decideRefund(actor, requestId, approve, note, req);
  }

  private refundView(r: {
    id: string;
    paymentId: string;
    status: string;
    reason: string;
    createdAt: Date;
    decidedAt: Date | null;
    decisionNote: string | null;
  }) {
    return {
      id: r.id,
      paymentId: r.paymentId,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      decisionNote: r.status === 'REFUSED' || r.status === 'NEEDS_REVIEW' ? r.decisionNote : null,
    };
  }

  // --------------------------------------------------------------- history

  async payments(workspaceId: string, q: PaymentsQueryDto) {
    const take = q.take ?? 30;
    const rows = await this.db.payment.findMany({
      where: { workspaceId, status: { not: 'PENDING' } },
      orderBy: { createdAt: 'desc' },
      take,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { refundRequest: true },
    });
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId }, select: { id: true } });
    const balance = wallet ? await this.ledger.balance(wallet.id) : 0;
    const out = [];
    for (const p of rows) {
      const e = await this.refundEligibility(p, balance);
      out.push({
        ...this.paymentView(p),
        refund: p.refundRequest ? this.refundView(p.refundRequest) : null,
        canRequestRefund: e.ok && (!p.refundRequest || p.refundRequest.status === 'CANCELLED' || p.refundRequest.status === 'REFUSED'),
        refundWhy: e.ok ? null : e.why,
      });
    }
    return { rows: out, nextCursor: rows.length === take ? (rows[rows.length - 1]?.id ?? null) : null, refundWindowDays: REFUND_WINDOW_DAYS };
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
      return {
        kind: 'pack',
        code: pack.code,
        credits: pack.credits,
        amountMinor: toMinor(price, currency),
        currency,
        providerRef: refFor(pack.providerRefs, provider, 'once'),
        label: `${pack.credits} AnyStudio credits`,
      };
    }
    const plan = await this.db.plan.findFirst({ where: { code: dto.code, active: true } });
    if (!plan) throw new NotFoundError('plan');
    const interval: Interval = dto.interval ?? 'month';
    const by = interval === 'year' ? plan.yearlyPriceByMarket : plan.priceByMarket;
    const price = priceIn(by, currency);
    if (price === null || price <= 0)
      throw new ValidationError({ interval: `${plan.code} cannot be billed ${interval === 'year' ? 'yearly' : 'monthly'} in ${currency}.` });
    return {
      kind: 'plan',
      code: plan.code,
      credits: plan.credits,
      interval,
      amountMinor: toMinor(price, currency),
      currency,
      providerRef: refFor(plan.providerRefs, provider, interval),
      label: `AnyStudio ${plan.code} plan, ${interval === 'year' ? 'yearly' : 'monthly'}`,
    };
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
    return {
      id: s.id,
      planCode: s.planCode,
      interval: s.interval,
      status: s.status,
      provider: s.provider,
      currentPeriodStart: s.currentPeriodStart,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      cancelledAt: s.cancelledAt,
      cancellationPending: s.providerCancelPending,
    };
  }

  private paymentView(p: Payment) {
    return {
      id: p.id,
      reference: p.reference,
      provider: p.provider,
      kind: p.kind,
      status: p.status,
      itemCode: p.itemCode,
      interval: p.interval,
      credits: p.credits,
      amountMinor: p.amountMinor,
      currency: p.currency,
      checkoutUrl: p.status === 'PENDING' ? p.checkoutUrl : null,
      failureReason: p.failureReason,
      refundedAt: p.refundedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }
}

function itemWords(p: Payment): string {
  return p.kind === 'PACK'
    ? `credit pack ${p.itemCode}`
    : p.kind === 'INVOICE'
      ? `invoice ${p.itemCode}`
      : `${p.itemCode} plan${p.kind === 'RENEWAL' ? ' renewal' : ''}`;
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

function webhookRetryDelay(attempts: number): number {
  return Math.min(WEBHOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), WEBHOOK_RETRY_MAX_MS);
}

function refundBackoff(attempts: number): number {
  return Math.min(REFUND_RECHECK_MS * 2 ** Math.max(0, attempts - 1), REFUND_RETRY_MAX_MS);
}

function refundReservationKey(requestId: string, cycle: number): string {
  return cycle === 0 ? `refund-request:${requestId}:reserve` : `refund-request:${requestId}:cycle:${cycle}:reserve`;
}

function refundReleaseKey(requestId: string, cycle: number): string {
  return cycle === 0 ? `refund-request:${requestId}:release` : `refund-request:${requestId}:cycle:${cycle}:release`;
}

type AdjustmentProviderMetadata = {
  providerAction?: string;
  reversalMode?: 'separate_adjustment';
  economicReversalOfAction?: string;
  economicReversalOfProviderRef?: string;
  economicReversedByProviderRef?: string;
};

function adjustmentProviderMetadata(payload: Prisma.JsonValue | null | undefined): AdjustmentProviderMetadata {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const value = payload as Record<string, Prisma.JsonValue>;
  return {
    providerAction: typeof value.providerAction === 'string' ? value.providerAction : undefined,
    reversalMode: value.reversalMode === 'separate_adjustment' ? 'separate_adjustment' : undefined,
    economicReversalOfAction: typeof value.economicReversalOfAction === 'string' ? value.economicReversalOfAction : undefined,
    economicReversalOfProviderRef: typeof value.economicReversalOfProviderRef === 'string' ? value.economicReversalOfProviderRef : undefined,
    economicReversedByProviderRef: typeof value.economicReversedByProviderRef === 'string' ? value.economicReversedByProviderRef : undefined,
  };
}

function adjustmentProviderPayload(
  payload: Prisma.JsonValue | null | undefined,
  verification: Pick<RefundVerification, 'providerAction' | 'reversalMode'>,
  links: Pick<AdjustmentProviderMetadata, 'economicReversalOfAction' | 'economicReversalOfProviderRef' | 'economicReversedByProviderRef'> = {},
): Prisma.InputJsonObject | undefined {
  const existing = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const next = {
    ...existing,
    ...(verification.providerAction ? { providerAction: normalizedAdjustmentAction(verification.providerAction) } : {}),
    ...(verification.reversalMode ? { reversalMode: verification.reversalMode } : {}),
    ...(links.economicReversalOfAction ? { economicReversalOfAction: links.economicReversalOfAction } : {}),
    ...(links.economicReversalOfProviderRef ? { economicReversalOfProviderRef: links.economicReversalOfProviderRef } : {}),
    ...(links.economicReversedByProviderRef ? { economicReversedByProviderRef: links.economicReversedByProviderRef } : {}),
  } as Prisma.InputJsonObject;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizedAdjustmentAction(action: string | undefined): string | null {
  const normalized = action?.trim().toLowerCase();
  return normalized || null;
}

function originalActionForReverse(action: string | null): string | null {
  return action?.endsWith('_reverse') ? action.slice(0, -'_reverse'.length) : null;
}

/**
 * Resolve the one RefundRequest cycle an immutable provider adjustment may
 * affect. RefundRequest is one-to-one with Payment, so its stable row id plus
 * the monotonic cycle is the command identity. Unsolicited adjustments remain
 * economically authoritative, but cannot consume a reservation or transition
 * a request unless the provider ref was acknowledged for that cycle. The one
 * exception is a terminal success racing the sole unacknowledged in-flight
 * command; adopting it prevents a second clawback or redundant provider POST.
 */
function refundCycleBinding(
  request: Pick<RefundRequest, 'id' | 'refundCycle' | 'gatewayRef' | 'processingAt' | 'status'> | null,
  explicit: RefundCycleContext | undefined,
  providerRef: string | undefined,
  adjustmentCycle: number | null,
  allowUnacknowledgedRequest: boolean,
): RefundCycleContext | null {
  if (!request) return null;
  if (adjustmentCycle !== null) {
    if (request.refundCycle !== adjustmentCycle) return null;
    if (explicit && (explicit.requestId !== request.id || explicit.refundCycle !== adjustmentCycle)) return null;
    return { requestId: request.id, refundCycle: adjustmentCycle };
  }
  if (explicit) {
    return explicit.requestId === request.id && explicit.refundCycle === request.refundCycle ? explicit : null;
  }
  if (
    providerRef &&
    (request.status === 'PROCESSING' || request.status === 'NEEDS_REVIEW') &&
    (request.gatewayRef === providerRef ||
      (allowUnacknowledgedRequest && request.status === 'PROCESSING' && request.gatewayRef === null && request.processingAt === null))
  ) {
    return { requestId: request.id, refundCycle: request.refundCycle };
  }
  return null;
}

type ProviderContext = {
  catalogueRef?: string;
  subscriptionRef?: string;
  customerRef?: string;
};

type RenewalTiming = {
  occurredAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
};

type SuccessfulRenewalSnapshot = Pick<Payment, 'id' | 'createdAt' | 'updatedAt' | 'providerPayload'>;
type OtherSubscriptionPayment = Pick<Payment, 'providerPayload'>;

/**
 * Decide whether a failed renewal is authoritative for the subscription that
 * is locked by settle(). Provider time/period wins over delivery order: a
 * delayed webhook can create its Payment row after a newer charge, so
 * Payment.createdAt alone is never evidence that the failure is current.
 */
function renewalFailureAuthority(
  failed: Payment,
  verificationRaw: unknown,
  subscription: Subscription,
  successfulRenewals: SuccessfulRenewalSnapshot[],
): { current: boolean; reason: string } {
  const failure = renewalTiming(verificationRaw);

  if (failure.occurredAt && subscription.providerUpdatedAt && failure.occurredAt.getTime() <= subscription.providerUpdatedAt.getTime()) {
    return { current: false, reason: 'a newer provider subscription status is already applied' };
  }

  if (successfulRenewals.length === 0) {
    if (failure.periodEnd && subscription.currentPeriodEnd && failure.periodEnd.getTime() <= subscription.currentPeriodEnd.getTime()) {
      return { current: false, reason: 'the failed provider period is already covered by the active subscription' };
    }
    if (failure.occurredAt && subscription.currentPeriodStart && failure.occurredAt.getTime() < subscription.currentPeriodStart.getTime()) {
      return { current: false, reason: 'the failure predates the active subscription period' };
    }
    if (!failure.occurredAt && !failure.periodStart && !failure.periodEnd && subscription.providerUpdatedAt) {
      return { current: false, reason: 'the failure has no provider ordering data and a provider subscription status is already applied' };
    }
    return { current: true, reason: 'this is the first recorded renewal attempt' };
  }

  // A successful renewal already covers the same (or a later) provider
  // period. Equality matters: providers may retry several transactions for
  // one billing period, and a failed sibling cannot undo the paid sibling.
  if (failure.periodEnd && subscription.currentPeriodEnd) {
    if (failure.periodEnd.getTime() <= subscription.currentPeriodEnd.getTime()) {
      return { current: false, reason: 'a successful renewal covers this provider period' };
    }
    return { current: true, reason: 'the failed provider period follows the last paid period' };
  }
  if (failure.periodStart && subscription.currentPeriodStart && failure.periodStart.getTime() <= subscription.currentPeriodStart.getTime()) {
    return { current: false, reason: 'the failed provider period is not newer than the paid period' };
  }

  const latestSuccessfulOccurrence = latestDate(successfulRenewals.map((row) => renewalTiming(row.providerPayload).occurredAt));
  if (failure.occurredAt && latestSuccessfulOccurrence) {
    return failure.occurredAt.getTime() > latestSuccessfulOccurrence.getTime()
      ? { current: true, reason: 'the provider failure occurred after the latest successful renewal' }
      : { current: false, reason: 'the provider failure occurred before the latest successful renewal' };
  }

  // If the provider omitted comparable timing, only an attempt after the end
  // of the currently paid period is strong enough to regress service. A
  // dedicated subscription.past_due webhook can still authoritatively do so.
  if (failure.occurredAt && subscription.currentPeriodEnd && failure.occurredAt.getTime() >= subscription.currentPeriodEnd.getTime()) {
    return { current: true, reason: 'the provider failure occurred after the currently paid period' };
  }

  const successCreatedAfterFailure = successfulRenewals.some((row) => row.createdAt.getTime() >= failed.createdAt.getTime());
  return {
    current: false,
    reason: successCreatedAfterFailure
      ? 'a different renewal payment succeeded after this attempt was recorded'
      : 'provider ordering is ambiguous and a successful renewal is current',
  };
}

function renewalTiming(value: unknown): RenewalTiming {
  const root = jsonRecord(value);
  const persistedTiming = jsonRecord(root?.renewalTiming);
  const verification = jsonRecord(root?.verification) ?? root;
  const transaction = jsonRecord(verification?.tx) ?? verification;
  const embeddedSubscription = jsonRecord(verification?.subscription) ?? jsonRecord(transaction?.subscription);
  const billingPeriod =
    jsonRecord(transaction?.billing_period) ??
    jsonRecord(transaction?.billingPeriod) ??
    jsonRecord(verification?.billing_period) ??
    jsonRecord(embeddedSubscription?.current_billing_period);

  return {
    occurredAt: firstDate(
      persistedTiming?.occurredAt,
      verification?.occurredAt,
      verification?.occurred_at,
      transaction?.billed_at,
      transaction?.created_at,
      transaction?.createdAt,
    ),
    periodStart: firstDate(
      persistedTiming?.periodStart,
      verification?.periodStart,
      verification?.period_start,
      transaction?.periodStart,
      billingPeriod?.starts_at,
      billingPeriod?.start,
    ),
    periodEnd: firstDate(
      persistedTiming?.periodEnd,
      verification?.periodEnd,
      verification?.period_end,
      transaction?.periodEnd,
      billingPeriod?.ends_at,
      billingPeriod?.end,
    ),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstDate(...values: unknown[]): Date | null {
  for (const value of values) {
    if (!(typeof value === 'string' || value instanceof Date)) continue;
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return null;
}

function latestDate(values: Array<Date | null>): Date | null {
  return values.reduce<Date | null>((latest, value) => (!value || (latest && latest.getTime() >= value.getTime()) ? latest : value), null);
}

function advanceBillingPeriod(anchor: Date, interval: string | null): Date {
  return new Date(anchor.getTime() + (interval === 'year' ? 365 : 30) * 86_400_000);
}

/**
 * A refund or chargeback may cancel only the payment that owns the provider's
 * current subscription period. An initial charge is necessarily historical
 * once any renewal exists. For later renewals, provider period/occurrence is
 * required when there is another candidate; receipt order alone is ambiguous.
 */
function paymentOwnsCurrentSubscriptionPeriod(payment: Payment, subscription: Subscription, others: OtherSubscriptionPayment[]): boolean {
  if (others.length === 0) return true;
  if (payment.kind !== 'RENEWAL') return false;

  const target = renewalTiming(payment.providerPayload);
  if (target.periodEnd && subscription.currentPeriodEnd && target.periodEnd.getTime() < subscription.currentPeriodEnd.getTime()) return false;

  const otherTimings = others.map((row) => renewalTiming(row.providerPayload));
  if (target.periodEnd && otherTimings.every((timing) => timing.periodEnd)) {
    const latestOtherPeriod = latestDate(otherTimings.map((timing) => timing.periodEnd));
    return Boolean(
      latestOtherPeriod &&
      target.periodEnd.getTime() > latestOtherPeriod.getTime() &&
      (!subscription.currentPeriodEnd || target.periodEnd.getTime() >= subscription.currentPeriodEnd.getTime()),
    );
  }

  if (target.occurredAt && otherTimings.every((timing) => timing.occurredAt)) {
    const latestOtherOccurrence = latestDate(otherTimings.map((timing) => timing.occurredAt));
    return Boolean(latestOtherOccurrence && target.occurredAt.getTime() > latestOtherOccurrence.getTime());
  }

  return false;
}

function checkoutProviderContext(item: CheckoutItem): Prisma.InputJsonObject {
  return item.providerRef === undefined ? {} : { catalogueRef: String(item.providerRef) };
}

function providerContext(value: Prisma.JsonValue | null): ProviderContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const scalar = (key: keyof ProviderContext) => (typeof record[key] === 'string' ? (record[key] as string) : undefined);
  return { catalogueRef: scalar('catalogueRef'), subscriptionRef: scalar('subscriptionRef'), customerRef: scalar('customerRef') };
}

function verifiedProviderPayload(existing: Prisma.JsonValue | null, verification: unknown): Prisma.InputJsonObject {
  const context = providerContext(existing);
  const containment = automaticRefundContainment(existing);
  return {
    ...(context.catalogueRef ? { catalogueRef: context.catalogueRef } : {}),
    ...(context.subscriptionRef ? { subscriptionRef: context.subscriptionRef } : {}),
    ...(context.customerRef ? { customerRef: context.customerRef } : {}),
    ...(containment ? { automaticRefund: containment } : {}),
    verification: (verification ?? null) as Prisma.InputJsonValue,
  };
}

function verifiedSuccessfulProviderPayload(existing: Prisma.JsonValue | null, verification: Extract<Verification, { ok: true }>): Prisma.InputJsonObject {
  const rawTiming = renewalTiming(verification.raw);
  const occurredAt = rawTiming.occurredAt;
  const periodStart = verification.periodStart ?? rawTiming.periodStart;
  const periodEnd = verification.periodEnd ?? rawTiming.periodEnd;
  return {
    ...verifiedProviderPayload(existing, verification.raw),
    ...(occurredAt || periodStart || periodEnd
      ? {
          renewalTiming: {
            ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}),
            ...(periodStart ? { periodStart: periodStart.toISOString() } : {}),
            ...(periodEnd ? { periodEnd: periodEnd.toISOString() } : {}),
          },
        }
      : {}),
  };
}

type AutomaticRefundContainment = {
  required: true;
  reason: string;
  queuedAt: string;
};

function automaticRefundContainment(value: Prisma.JsonValue | null): AutomaticRefundContainment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const marker = (value as Record<string, unknown>).automaticRefund;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const record = marker as Record<string, unknown>;
  return record.required === true && typeof record.reason === 'string' && typeof record.queuedAt === 'string'
    ? { required: true, reason: record.reason, queuedAt: record.queuedAt }
    : null;
}

type OriginalChargeInvoiceEvidence = {
  status: string;
  paymentId: string | null;
  paidVia: string | null;
  paidReference: string | null;
};

/** A binding alone cannot override an already recorded settlement identity. */
function invoiceSettlementConflicts(invoice: OriginalChargeInvoiceEvidence, payment: Payment): boolean {
  return Boolean(
    (invoice.paymentId && invoice.paymentId !== payment.id) ||
    (invoice.paidVia && invoice.paidVia !== payment.provider) ||
    (invoice.paidReference && invoice.paidReference !== payment.providerRef),
  );
}

/**
 * Evidence that cannot disappear merely because an adjustment changes the
 * Payment's mutable status. Automatic containment is included because only
 * settle(), after a successful provider verification, can write its marker.
 */
function immutableOriginalChargeFulfilled(payment: Payment, invoice: OriginalChargeInvoiceEvidence | null): boolean {
  if (payment.ledgerEntryId !== null || automaticRefundContainment(payment.providerPayload) !== null) return true;
  return Boolean(
    payment.kind === 'INVOICE' &&
    invoice?.status === 'PAID' &&
    (invoice.paymentId === payment.id || invoice.paymentId === null) &&
    invoice.paidVia === payment.provider &&
    payment.providerRef !== null &&
    invoice.paidReference === payment.providerRef,
  );
}

function isRecoverableEarlyAdjustment(payment: Payment): boolean {
  return payment.status === 'NEEDS_REVIEW' && payment.ledgerEntryId === null && payment.failureReason?.startsWith('Partial provider adjustment:') === true;
}

function automaticRefundProviderPayload(existing: Prisma.JsonValue | null, verification: unknown, reason: string): Prisma.InputJsonObject {
  return {
    ...verifiedProviderPayload(existing, verification),
    automaticRefund: automaticRefundContainment(existing) ?? {
      required: true,
      reason,
      queuedAt: new Date().toISOString(),
    },
  };
}

function definitiveCheckoutRejection(error: unknown): boolean {
  return error instanceof ProviderError && (error.kind === 'REQUEST_REJECTED' || error.kind === 'INVALID_INPUT' || error.kind === 'CONTENT_REJECTED');
}

function checkoutRecoveryAttempts(value: Prisma.JsonValue | null): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const recovery = (value as Record<string, unknown>).checkoutRecovery;
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return 0;
  const attempts = (recovery as Record<string, unknown>).attempts;
  return typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
}

function checkoutRecoveryPayload(existing: Prisma.JsonValue | null, attempts: number, error: string): Prisma.InputJsonObject {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Prisma.JsonObject) : {};
  return {
    ...base,
    checkoutRecovery: { attempts, lastError: error.slice(0, 1000), lastAttemptAt: new Date().toISOString() },
  };
}

export type { Plan, CreditPack };
