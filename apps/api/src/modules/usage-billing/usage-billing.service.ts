/**
 * Usage-based billing for organizations.
 *
 * HOW IT FITS THE LEDGER
 * ----------------------
 * Nothing about metering changes: every generation still debits credits
 * through ledger_apply, at the moment it is asked for. What changes for a
 * postpaid organization is the floor — its wallet may go below zero as far
 * as its credit limit — so the balance reads as "credits used and not yet
 * paid for", negative. At the close of each calendar month the net debits
 * of the period are priced with the rate card and written as an invoice;
 * paying the invoice puts the invoiced credits back through the ledger, so
 * the balance climbs toward zero again. Prepaid credits an organization
 * already held stay as a buffer above the line and are never invoiced.
 *
 * THE DATABASE IS THE QUEUE
 * -------------------------
 * The worker calls tick() hourly. Closing a period is a unique insert on
 * (account, periodStart), so two workers cannot issue the same month twice;
 * dunning is a conditional update; suspension sets the wallet's overdraft
 * to zero under the same row the ledger locks, so the next debit is refused
 * by the database, not by a flag the application might forget to check.
 *
 * Terms are set by staff. Opening a credit line is a credit decision.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type BillingAccount, type Invoice } from '@prisma/client';
import type { Request } from 'express';
import { surfaceOriginFor, type AppEnv } from '@anystudio/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { accountPaused, invoiceIssued, invoiceOverdue, invoicePaid } from '../../assets/email-templates';
import { Mailer, type Mail } from '../../utils/mail-service';
import { authLog } from '../auth/auth.log';
import { assertStaffMutation, type Actor } from '../auth/policy';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notification/notification.service';
import { toMajor } from '../billing/billing.types';
import type { AccountPatchDto, AccountTermsDto, AdminInvoicesQueryDto, InvoicesQueryDto, MarkPaidDto } from './usage-billing.dto';
import { addDays, invoiceNumber, monthOf, priceCredits, priceUsage, type BillTo, type UsageLine } from './usage-billing.types';

const BUYERS = new Set(['OWNER', 'ADMIN', 'BILLING']);
/** Staff mutations accept a factor confirmed within the last half hour; the console re-prompts after that. */
const STEP_UP_MIN = 30;
/** Warn the organization once per period when this much of the credit line is used. */
const LIMIT_WARN_AT = 0.8;

interface RawUsage {
  costCode: string;
  label: string;
  requests: number;
  credits: number;
}

@Injectable()
export class UsageBillingService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly mailer: Mailer,
    private readonly notifications: NotificationService,
  ) {}

  // ------------------------------------------------------- the organization

  /** The account as the organization sees it, with this period so far. Null account means prepaid. */
  async account(workspaceId: string) {
    const [ws, account] = await Promise.all([
      this.db.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, currency: true, type: true } }),
      this.db.billingAccount.findUnique({ where: { workspaceId } }),
    ]);
    if (!ws) throw new NotFoundError('workspace');
    const bankDetails = process.env.BANK_TRANSFER_DETAILS?.trim() || null;
    if (!account) return { account: null, period: null, open: null, bankDetails, canRequest: ws.type === 'ORGANIZATION' };

    const wallet = await this.db.wallet.findUniqueOrThrow({ where: { workspaceId }, select: { id: true, overdraftLimit: true } });
    const now = new Date();
    const periodStart = await this.openPeriodStart(account, now);
    const [balance, raw, rate, open] = await Promise.all([
      this.ledger.balance(wallet.id),
      this.usage(wallet.id, periodStart, now),
      this.rateFor(account),
      this.db.invoice.aggregate({ where: { accountId: account.id, status: { in: ['OPEN', 'OVERDUE'] } }, _sum: { totalMinor: true }, _count: true }),
    ]);
    const priced = priceUsage(raw, rate, account.minimumMinor);
    return {
      account: this.accountView(account, rate),
      period: {
        start: periodStart,
        end: monthOf(periodStart).end,
        credits: priced.credits,
        lines: priced.lines,
        estimateMinor: priced.totalMinor,
        balance,
        creditLimit: account.creditLimit,
        available: Math.max(0, balance + wallet.overdraftLimit),
      },
      open: { count: open._count, totalMinor: open._sum.totalMinor ?? 0 },
      bankDetails,
      canRequest: false,
    };
  }

  async patchAccount(actor: Actor, workspaceId: string, dto: AccountPatchDto, req: Request) {
    this.assertBuyer(actor, workspaceId);
    const account = await this.db.billingAccount.findUnique({ where: { workspaceId } });
    if (!account) throw new NotFoundError('billing account');
    const updated = await this.db.billingAccount.update({
      where: { id: account.id },
      data: {
        ...(dto.billingEmail !== undefined ? { billingEmail: dto.billingEmail?.trim().toLowerCase() || null } : {}),
        ...(dto.billTo !== undefined ? { billTo: cleanBillTo(dto.billTo) as Prisma.InputJsonValue } : {}),
      },
    });
    authLog('billing.account', 'succeeded', { userId: actor.userId, workspaceId, fields: Object.keys(dto) }, req);
    return this.accountView(updated, await this.rateFor(updated));
  }

  async invoices(workspaceId: string, q: InvoicesQueryDto) {
    const take = q.take ?? 25;
    const rows = await this.db.invoice.findMany({
      where: { workspaceId },
      orderBy: [{ periodStart: 'desc' }, { issuedAt: 'desc' }],
      take,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return { rows: rows.map((i) => this.invoiceView(i)), nextCursor: rows.length === take ? (rows[rows.length - 1]?.id ?? null) : null };
  }

  async invoice(workspaceId: string, id: string) {
    const inv = await this.db.invoice.findFirst({ where: { id, workspaceId }, include: { account: true } });
    if (!inv) throw new NotFoundError('invoice');
    return { ...this.invoiceView(inv), bankDetails: process.env.BANK_TRANSFER_DETAILS?.trim() || null };
  }

  // ------------------------------------------------------------- settlement

  /**
   * Money arrived for an invoice — online through BillingService, or a bank
   * transfer recorded by staff. Idempotent on the invoice's status and on
   * the ledger key, so a webhook and a return page settling together add
   * the credits once.
   */
  async settleInvoice(invoiceId: string, via: string, reference: string | null, paymentId: string | null): Promise<Invoice> {
    const inv = await this.db.invoice.findUnique({ where: { id: invoiceId }, include: { account: true, workspace: { select: { name: true } } } });
    if (!inv) throw new NotFoundError('invoice');
    if (inv.status === 'PAID') return inv;
    if (inv.status === 'VOID') throw new ConflictError(`Invoice ${inv.number} was voided.`);

    let ledgerEntryId: string | null = null;
    if (inv.credits > 0) {
      const wallet = await this.db.wallet.findUniqueOrThrow({ where: { workspaceId: inv.workspaceId }, select: { id: true } });
      const entry = await this.ledger.purchase({
        walletId: wallet.id,
        amount: inv.credits,
        idempotencyKey: `invoice:${inv.id}`,
        referenceId: inv.id,
        reason: `Invoice ${inv.number} paid`,
      });
      ledgerEntryId = entry.id;
    }
    const paid = await this.db.invoice.update({
      where: { id: inv.id },
      data: { status: 'PAID', paidAt: new Date(), paidVia: via, paidReference: reference, paymentId, ledgerEntryId },
    });
    logger.info(
      {
        invoiceId: inv.id,
        number: inv.number,
        workspaceId: inv.workspaceId,
        via,
        reference,
        totalMinor: inv.totalMinor,
        currency: inv.currency,
        ledgerEntryId,
      },
      'invoice paid; credits returned to the line',
    );
    await this.reactivateIfClear(inv.account);
    if (inv.totalMinor > 0) {
      const facts = this.mailFacts(paid, inv.workspace.name);
      await this.mailAll(inv.workspaceId, inv.account.billingEmail, (to, name) => invoicePaid(to, name, { ...facts, via: VIA_WORDS[via] ?? via, reference }));
      await this.notifications.notifyWorkspace(inv.workspaceId, null, {
        kind: 'CREDITS',
        title: `Invoice ${inv.number} paid`,
        body: `${money(inv.totalMinor, inv.currency)} received. Thank you.`,
        href: `/billing/invoices/${inv.id}`,
        refId: `invoice-paid:${inv.id}`,
      });
    }
    return paid;
  }

  // ------------------------------------------------------------- the worker

  /** Everything time does to billing, in one hourly call. Each part fails on its own. */
  async tick(now = new Date()): Promise<{ closed: number; overdue: number; suspended: number; warned: number }> {
    const out = { closed: 0, overdue: 0, suspended: 0, warned: 0 };
    try {
      out.closed = await this.closeDue(now);
    } catch (err) {
      logger.error({ err }, 'invoice close failed');
    }
    try {
      const d = await this.dun(now);
      out.overdue = d.overdue;
      out.suspended = d.suspended;
    } catch (err) {
      logger.error({ err }, 'dunning failed');
    }
    try {
      out.warned = await this.warnLimits(now);
    } catch (err) {
      logger.error({ err }, 'credit-line warning failed');
    }
    return out;
  }

  /** Issue an invoice for every completed period that has none. */
  async closeDue(now = new Date()): Promise<number> {
    const accounts = await this.db.billingAccount.findMany({ where: { status: { in: ['ACTIVE', 'SUSPENDED'] } } });
    let n = 0;
    for (const account of accounts) {
      for (;;) {
        const start = await this.openPeriodStart(account, now);
        const end = monthOf(start).end;
        if (end > now) break;
        const issued = await this.issue(account, start, end);
        if (!issued) break;
        n++;
      }
    }
    return n;
  }

  /** OPEN past due → OVERDUE with one reminder; OVERDUE past grace → the account is paused. */
  async dun(now = new Date()): Promise<{ overdue: number; suspended: number }> {
    let overdue = 0;
    let suspended = 0;
    const due = await this.db.invoice.findMany({
      where: { status: 'OPEN', dueAt: { lt: now }, totalMinor: { gt: 0 } },
      include: { account: true, workspace: { select: { name: true } } },
    });
    for (const inv of due) {
      const r = await this.db.invoice.updateMany({ where: { id: inv.id, status: 'OPEN' }, data: { status: 'OVERDUE', remindedAt: now } });
      if (r.count === 0) continue;
      overdue++;
      logger.warn({ invoiceId: inv.id, number: inv.number, workspaceId: inv.workspaceId, dueAt: inv.dueAt }, 'invoice overdue');
      const facts = this.mailFacts(inv, inv.workspace.name);
      await this.mailAll(inv.workspaceId, inv.account.billingEmail, (to, name) => invoiceOverdue(to, name, { ...facts, graceDays: inv.account.graceDays }));
      await this.notifications.notifyWorkspace(inv.workspaceId, null, {
        kind: 'CREDITS',
        title: `Invoice ${inv.number} is overdue`,
        body: `${money(inv.totalMinor, inv.currency)} was due ${dateWords(inv.dueAt)}.`,
        href: `/billing/invoices/${inv.id}`,
        refId: `invoice-overdue:${inv.id}`,
      });
    }

    const lapsed = await this.db.invoice.findMany({
      where: { status: 'OVERDUE', account: { status: 'ACTIVE' } },
      include: { account: true, workspace: { select: { name: true } } },
    });
    const byAccount = new Map<string, typeof lapsed>();
    for (const inv of lapsed) {
      if (addDays(inv.dueAt, inv.account.graceDays) > now) continue;
      byAccount.set(inv.accountId, [...(byAccount.get(inv.accountId) ?? []), inv]);
    }
    for (const [, invs] of byAccount) {
      const account = invs[0]!.account;
      const r = await this.db.billingAccount.updateMany({
        where: { id: account.id, status: 'ACTIVE' },
        data: { status: 'SUSPENDED', suspendedAt: now, suspendedReason: `overdue: ${invs.map((i) => i.number).join(', ')}` },
      });
      if (r.count === 0) continue;
      await this.db.wallet.update({ where: { workspaceId: account.workspaceId }, data: { overdraftLimit: 0 } });
      suspended++;
      const total = invs.reduce((n, i) => n + i.totalMinor, 0);
      logger.error(
        { accountId: account.id, workspaceId: account.workspaceId, invoices: invs.map((i) => i.number), totalMinor: total, currency: account.currency },
        'ACCOUNT PAUSED: invoices overdue past grace; credit line closed',
      );
      const url = `${this.orgOrigin()}/billing`;
      await this.mailAll(account.workspaceId, account.billingEmail, (to, name) =>
        accountPaused(to, name, { workspaceName: invs[0]!.workspace.name, numbers: invs.map((i) => i.number), total: money(total, account.currency), url }),
      );
      await this.notifications.notifyWorkspace(account.workspaceId, null, {
        kind: 'SYSTEM',
        title: 'New work is paused',
        body: `${money(total, account.currency)} is overdue. Everything resumes as soon as it is paid.`,
        href: '/billing',
        refId: `account-paused:${account.id}:${now.toISOString().slice(0, 10)}`,
      });
    }
    return { overdue, suspended };
  }

  /** Once per period, when the line is 80% used: a heads-up, not a stop. */
  async warnLimits(now = new Date()): Promise<number> {
    const accounts = await this.db.billingAccount.findMany({
      where: { status: 'ACTIVE', creditLimit: { gt: 0 } },
      include: { workspace: { select: { name: true } } },
    });
    let n = 0;
    for (const account of accounts) {
      const periodStart = await this.openPeriodStart(account, now);
      if (account.limitWarnedFor && account.limitWarnedFor.getTime() === periodStart.getTime()) continue;
      const wallet = await this.db.wallet.findUnique({ where: { workspaceId: account.workspaceId }, select: { id: true } });
      if (!wallet) continue;
      const balance = await this.ledger.balance(wallet.id);
      if (-balance < account.creditLimit * LIMIT_WARN_AT) continue;
      const r = await this.db.billingAccount.updateMany({
        where: { id: account.id, OR: [{ limitWarnedFor: null }, { limitWarnedFor: { not: periodStart } }] },
        data: { limitWarnedFor: periodStart },
      });
      if (r.count === 0) continue;
      n++;
      const used = Math.round((-balance / account.creditLimit) * 100);
      logger.warn({ accountId: account.id, workspaceId: account.workspaceId, balance, creditLimit: account.creditLimit, used }, 'credit line nearly used');
      await this.notifications.notifyWorkspace(account.workspaceId, null, {
        kind: 'CREDITS',
        title: `${used}% of the credit line used`,
        body: `${(-balance).toLocaleString()} of ${account.creditLimit.toLocaleString()} credits this period. Pay an open invoice or ask us to raise the limit.`,
        href: '/billing',
        refId: `limit-warn:${account.id}:${periodStart.toISOString().slice(0, 7)}`,
      });
    }
    return n;
  }

  // ------------------------------------------------------------------ staff

  async accounts() {
    const rows = await this.db.billingAccount.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: { workspace: { select: { id: true, name: true, currency: true, wallet: { select: { id: true, overdraftLimit: true } } } } },
    });
    const out = [];
    for (const a of rows) {
      const balance = a.workspace.wallet ? await this.ledger.balance(a.workspace.wallet.id) : 0;
      const open = await this.db.invoice.aggregate({
        where: { accountId: a.id, status: { in: ['OPEN', 'OVERDUE'] } },
        _sum: { totalMinor: true },
        _count: true,
      });
      out.push({
        ...this.accountView(a, await this.rateFor(a)),
        workspace: { id: a.workspace.id, name: a.workspace.name },
        balance,
        overdraftLimit: a.workspace.wallet?.overdraftLimit ?? 0,
        open: { count: open._count, totalMinor: open._sum.totalMinor ?? 0 },
        notes: a.notes,
      });
    }
    return out;
  }

  async adminInvoices(q: AdminInvoicesQueryDto) {
    const take = q.take ?? 25;
    const rows = await this.db.invoice.findMany({
      where: { ...(q.status ? { status: q.status } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}) },
      orderBy: { issuedAt: 'desc' },
      take,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { workspace: { select: { id: true, name: true } } },
    });
    return {
      rows: rows.map((i) => ({ ...this.invoiceView(i), workspace: i.workspace })),
      nextCursor: rows.length === take ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  }

  /** Open a credit line, or change its terms. The wallet's overdraft follows the limit while the account is active. */
  async setTerms(actor: Actor, workspaceId: string, dto: AccountTermsDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', workspaceId, stepUpMinutes: STEP_UP_MIN });
    const ws = await this.db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, type: true, currency: true, wallet: { select: { id: true } } },
    });
    if (!ws) throw new NotFoundError('workspace');
    if (ws.type !== 'ORGANIZATION') throw new ValidationError({ workspaceId: 'Only organization workspaces can be invoiced.' });
    if (!ws.wallet) throw new NotFoundError('wallet');
    const existing = await this.db.billingAccount.findUnique({ where: { workspaceId } });
    if (!existing && dto.creditLimit === undefined) throw new ValidationError({ creditLimit: 'A credit limit is needed to open the account.' });
    if (!existing) {
      const listed = await this.db.usageRate.findUnique({ where: { currency: ws.currency.toUpperCase() } });
      if (!listed && !dto.per100Minor) throw new ValidationError({ per100Minor: `There is no list rate in ${ws.currency}; set a negotiated rate.` });
    }
    const data = {
      ...(dto.creditLimit !== undefined ? { creditLimit: dto.creditLimit } : {}),
      ...(dto.per100Minor !== undefined ? { per100Minor: dto.per100Minor } : {}),
      ...(dto.minimumMinor !== undefined ? { minimumMinor: dto.minimumMinor } : {}),
      ...(dto.netDays !== undefined ? { netDays: dto.netDays } : {}),
      ...(dto.graceDays !== undefined ? { graceDays: dto.graceDays } : {}),
      ...(dto.billingEmail !== undefined ? { billingEmail: dto.billingEmail?.trim().toLowerCase() || null } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };
    const account = existing
      ? await this.db.billingAccount.update({
          where: { id: existing.id },
          data: existing.status === 'CLOSED' ? { ...data, status: 'ACTIVE', closedAt: null, startedAt: new Date() } : data,
        })
      : await this.db.billingAccount.create({
          data: { workspaceId, currency: ws.currency.toUpperCase(), creditLimit: dto.creditLimit!, createdById: actor.userId, ...data },
        });
    if (account.status === 'ACTIVE') await this.db.wallet.update({ where: { id: ws.wallet.id }, data: { overdraftLimit: account.creditLimit } });
    authLog(
      'billing.terms',
      'succeeded',
      {
        userId: actor.userId,
        workspaceId,
        accountId: account.id,
        opened: !existing,
        changed: Object.keys(data),
        creditLimit: account.creditLimit,
        reason: dto.reason,
      },
      req,
    );
    logger.info(
      { accountId: account.id, workspaceId, creditLimit: account.creditLimit, opened: !existing, by: actor.userId },
      existing ? 'credit line terms changed' : 'credit line opened',
    );
    return this.accountView(account, await this.rateFor(account));
  }

  /** Back to prepaid. The partial period is invoiced now so nothing used goes unbilled. */
  async closeAccount(actor: Actor, workspaceId: string, reason: string, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', workspaceId, stepUpMinutes: STEP_UP_MIN });
    const account = await this.db.billingAccount.findUnique({ where: { workspaceId } });
    if (!account || account.status === 'CLOSED') throw new NotFoundError('billing account');
    const now = new Date();
    const final = await this.closePeriod(account, now);
    await this.db.billingAccount.update({
      where: { id: account.id },
      data: { status: 'CLOSED', closedAt: now, notes: joinNotes(account.notes, `Closed: ${reason}`) },
    });
    await this.db.wallet.update({ where: { workspaceId }, data: { overdraftLimit: 0 } });
    authLog(
      'billing.terms',
      'succeeded',
      { userId: actor.userId, workspaceId, accountId: account.id, closed: true, finalInvoice: final?.number ?? null, reason },
      req,
    );
    logger.info({ accountId: account.id, workspaceId, finalInvoice: final?.number ?? null }, 'credit line closed');
    return { closed: true, finalInvoice: final ? this.invoiceView(final) : null };
  }

  /** Lift a suspension by hand — a payment on its way, a dispute resolved. */
  async reactivate(actor: Actor, workspaceId: string, reason: string, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', workspaceId, stepUpMinutes: STEP_UP_MIN });
    const account = await this.db.billingAccount.findUnique({ where: { workspaceId } });
    if (!account || account.status !== 'SUSPENDED') throw new ConflictError('This account is not paused.');
    const updated = await this.db.billingAccount.update({
      where: { id: account.id },
      data: { status: 'ACTIVE', suspendedAt: null, suspendedReason: null, notes: joinNotes(account.notes, `Reactivated: ${reason}`) },
    });
    await this.db.wallet.update({ where: { workspaceId }, data: { overdraftLimit: updated.creditLimit } });
    authLog('billing.terms', 'succeeded', { userId: actor.userId, workspaceId, accountId: account.id, reactivated: true, reason }, req);
    return this.accountView(updated, await this.rateFor(updated));
  }

  /** Invoice the period so far — offboarding, a dispute, or seeing the numbers before month end. */
  async closePeriodNow(actor: Actor, workspaceId: string, reason: string, req: Request) {
    assertStaffMutation(actor, { min: 'OPERATOR', workspaceId, stepUpMinutes: STEP_UP_MIN });
    const account = await this.db.billingAccount.findUnique({ where: { workspaceId } });
    if (!account || account.status === 'CLOSED') throw new NotFoundError('billing account');
    const inv = await this.closePeriod(account, new Date());
    if (!inv) throw new ConflictError('Nothing to invoice yet for this period.');
    authLog('billing.invoice', 'succeeded', { userId: actor.userId, workspaceId, invoiceId: inv.id, number: inv.number, early: true, reason }, req);
    return this.invoiceView(inv);
  }

  /** Money arrived outside a gateway — a bank transfer. Staff record the reference. */
  async markPaid(actor: Actor, invoiceId: string, dto: MarkPaidDto, req: Request) {
    const inv = await this.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundError('invoice');
    assertStaffMutation(actor, { min: 'OPERATOR', workspaceId: inv.workspaceId, stepUpMinutes: STEP_UP_MIN });
    if (inv.status === 'PAID') throw new ConflictError(`Invoice ${inv.number} is already paid.`);
    const paid = await this.settleInvoice(inv.id, 'MANUAL', dto.reference, null);
    authLog(
      'billing.invoice',
      'succeeded',
      {
        userId: actor.userId,
        workspaceId: inv.workspaceId,
        invoiceId: inv.id,
        number: inv.number,
        markedPaid: true,
        reference: dto.reference,
        reason: dto.reason,
      },
      req,
    );
    return this.invoiceView(paid);
  }

  /** Cancel an invoice. The credits it billed are put back so the line is square; a corrected invoice can be issued by closing the period again. */
  async voidInvoice(actor: Actor, invoiceId: string, reason: string, req: Request) {
    const inv = await this.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundError('invoice');
    assertStaffMutation(actor, { min: 'ADMIN', workspaceId: inv.workspaceId, stepUpMinutes: STEP_UP_MIN });
    if (inv.status === 'PAID') throw new ConflictError('A paid invoice cannot be voided. Refund the payment instead.');
    if (inv.status === 'VOID') return this.invoiceView(inv);
    if (inv.credits > 0) {
      const wallet = await this.db.wallet.findUniqueOrThrow({ where: { workspaceId: inv.workspaceId }, select: { id: true } });
      await this.ledger.grant({
        walletId: wallet.id,
        amount: inv.credits,
        idempotencyKey: `invoice:${inv.id}:void`,
        referenceId: inv.id,
        reason: `Invoice ${inv.number} voided`,
      });
    }
    const voided = await this.db.invoice.update({ where: { id: inv.id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: reason } });
    const account = await this.db.billingAccount.findUnique({ where: { id: inv.accountId } });
    if (account) await this.reactivateIfClear(account);
    authLog(
      'billing.invoice',
      'succeeded',
      { userId: actor.userId, workspaceId: inv.workspaceId, invoiceId: inv.id, number: inv.number, voided: true, reason },
      req,
    );
    logger.warn(
      { invoiceId: inv.id, number: inv.number, workspaceId: inv.workspaceId, credits: inv.credits, by: actor.userId, reason },
      'invoice voided; credits returned',
    );
    return this.invoiceView(voided);
  }

  async rates() {
    return this.db.usageRate.findMany({ orderBy: { currency: 'asc' } });
  }

  // ---------------------------------------------------------------- private

  /** Net debits in [start, end) grouped by what was made. Refunds count against the code they refund. */
  private async usage(walletId: string, start: Date, end: Date): Promise<RawUsage[]> {
    const rows = await this.db.$queryRaw<Array<{ costCode: string | null; label: string | null; requests: bigint; credits: bigint }>>`
      SELECT g."costCode" AS "costCode", cc.label AS label,
             COUNT(*) FILTER (WHERE le.kind = 'DEBIT') AS requests,
             -SUM(le.delta) AS credits
        FROM ledger_entries le
        LEFT JOIN generations g ON g.id = le."referenceId"
        LEFT JOIN credit_costs cc ON cc.code = g."costCode"
       WHERE le."walletId" = ${walletId}::uuid
         AND le.kind IN ('DEBIT', 'REFUND')
         AND le."createdAt" >= ${start} AND le."createdAt" < ${end}
       GROUP BY 1, 2`;
    return rows.map((r) => ({
      costCode: r.costCode ?? 'other',
      label: r.label ?? (r.costCode ? r.costCode : 'Other usage'),
      requests: Number(r.requests),
      credits: Number(r.credits),
    }));
  }

  /** Where the next invoice starts: after the last one, or at the month the account opened. */
  private async openPeriodStart(account: BillingAccount, now: Date): Promise<Date> {
    const last = await this.db.invoice.findFirst({
      where: { accountId: account.id, status: { not: 'VOID' } },
      orderBy: { periodEnd: 'desc' },
      select: { periodEnd: true },
    });
    const start = last ? last.periodEnd : monthOf(account.startedAt).start;
    return start > now ? monthOf(now).start : start;
  }

  /** The current period up to `now`, as an invoice. Null when there is nothing at all to bill. */
  private async closePeriod(account: BillingAccount, now: Date): Promise<Invoice | null> {
    const start = await this.openPeriodStart(account, now);
    if (start >= now) return null;
    return this.issue(account, start, now);
  }

  /**
   * Price and write one invoice. The unique (account, periodStart) makes a
   * second worker's attempt a no-op; the number is taken from a count and
   * retried on collision, which at this volume is the whole story.
   */
  private async issue(account: BillingAccount, start: Date, end: Date): Promise<Invoice | null> {
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId: account.workspaceId }, select: { id: true } });
    if (!wallet) return null;
    const [raw, rate, ws] = await Promise.all([
      this.usage(wallet.id, start, end),
      this.rateFor(account),
      this.db.workspace.findUniqueOrThrow({ where: { id: account.workspaceId }, select: { name: true } }),
    ]);
    const priced = priceUsage(raw, rate, account.minimumMinor);
    const zero = priced.totalMinor === 0;
    const issuedAt = new Date();
    for (let attempt = 0; attempt < 5; attempt++) {
      const seq = (await this.db.invoice.count({ where: { periodStart: { gte: monthOf(start).start, lt: monthOf(start).end } } })) + 1 + attempt;
      try {
        const inv = await this.db.invoice.create({
          data: {
            number: invoiceNumber(start, seq),
            workspaceId: account.workspaceId,
            accountId: account.id,
            periodStart: start,
            periodEnd: end,
            currency: account.currency,
            credits: priced.credits,
            per100Minor: rate,
            usageMinor: priced.usageMinor,
            minimumMinor: priced.minimumMinor,
            totalMinor: priced.totalMinor,
            lines: priced.lines as unknown as Prisma.InputJsonValue,
            billTo: (account.billTo ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            issuedAt,
            dueAt: addDays(issuedAt, account.netDays),
            ...(zero ? { status: 'PAID', paidAt: issuedAt, paidVia: 'ZERO' } : {}),
          },
        });
        logger.info(
          {
            invoiceId: inv.id,
            number: inv.number,
            workspaceId: account.workspaceId,
            periodStart: start,
            periodEnd: end,
            credits: inv.credits,
            totalMinor: inv.totalMinor,
            currency: inv.currency,
            zero,
          },
          zero ? 'period closed; nothing to bill' : 'invoice issued',
        );
        if (!zero) {
          const facts = this.mailFacts(inv, ws.name);
          await this.mailAll(account.workspaceId, account.billingEmail, (to, name) => invoiceIssued(to, name, facts));
          await this.notifications.notifyWorkspace(account.workspaceId, null, {
            kind: 'CREDITS',
            title: `Invoice ${inv.number}: ${money(inv.totalMinor, inv.currency)}`,
            body: `${periodWords(start)} · ${inv.credits.toLocaleString()} credits · due ${dateWords(inv.dueAt)}.`,
            href: `/billing/invoices/${inv.id}`,
            refId: `invoice:${inv.id}`,
          });
        }
        return inv;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const target = (e.meta?.target as string[] | undefined)?.join(',') ?? '';
          if (target.includes('periodStart')) return null; // another worker closed it
          continue; // number collided; count again
        }
        throw e;
      }
    }
    logger.error({ accountId: account.id, periodStart: start }, 'INVOICE NOT ISSUED: could not allocate a number');
    return null;
  }

  private async reactivateIfClear(account: BillingAccount): Promise<void> {
    if (account.status !== 'SUSPENDED') return;
    const stillOpen = await this.db.invoice.count({ where: { accountId: account.id, status: 'OVERDUE' } });
    if (stillOpen > 0) return;
    const r = await this.db.billingAccount.updateMany({
      where: { id: account.id, status: 'SUSPENDED' },
      data: { status: 'ACTIVE', suspendedAt: null, suspendedReason: null },
    });
    if (r.count === 0) return;
    await this.db.wallet.update({ where: { workspaceId: account.workspaceId }, data: { overdraftLimit: account.creditLimit } });
    logger.info({ accountId: account.id, workspaceId: account.workspaceId }, 'account reactivated; overdue invoices cleared');
    await this.notifications.notifyWorkspace(account.workspaceId, null, {
      kind: 'SYSTEM',
      title: 'Work has resumed',
      body: 'The overdue invoices are settled. Thank you.',
      href: '/billing',
      refId: `account-resumed:${account.id}:${Date.now()}`,
    });
  }

  private async rateFor(account: Pick<BillingAccount, 'per100Minor' | 'currency'>): Promise<number> {
    if (account.per100Minor) return account.per100Minor;
    const r = await this.db.usageRate.findUnique({ where: { currency: account.currency.toUpperCase() } });
    return r?.per100Minor ?? 0;
  }

  /** Owners and the billing role, plus the billing address, each once. */
  private async mailAll(workspaceId: string, billingEmail: string | null, make: (to: string, name: string | null) => Mail) {
    const members = await this.db.workspaceMember.findMany({
      where: { workspaceId, role: { in: ['OWNER', 'BILLING'] } },
      include: { user: { select: { email: true, name: true } } },
    });
    const seen = new Set<string>();
    const targets: Array<{ to: string; name: string | null }> = [];
    for (const m of members) {
      const email = m.user.email?.toLowerCase();
      if (email && !seen.has(email)) {
        seen.add(email);
        targets.push({ to: email, name: m.user.name });
      }
    }
    if (billingEmail && !seen.has(billingEmail.toLowerCase())) targets.push({ to: billingEmail, name: null });
    for (const t of targets) {
      try {
        await this.mailer.send(make(t.to, t.name));
      } catch (err) {
        logger.error({ err, to: t.to, workspaceId }, 'invoice mail failed');
      }
    }
  }

  private mailFacts(inv: Invoice, workspaceName: string) {
    return {
      workspaceName,
      number: inv.number,
      period: periodWords(inv.periodStart),
      total: money(inv.totalMinor, inv.currency),
      credits: inv.credits,
      due: dateWords(inv.dueAt),
      url: `${this.orgOrigin()}/billing/invoices/${inv.id}`,
    };
  }

  private orgOrigin(): string {
    const raw = process.env.APP_ENV;
    const env: AppEnv = raw === 'production' || raw === 'staging' || raw === 'dev' ? raw : 'local';
    return surfaceOriginFor('ORG', env);
  }

  private assertBuyer(actor: Actor, workspaceId: string): void {
    const role = actor.workspaceRoles.get(workspaceId);
    if (!role || !BUYERS.has(role)) throw new ForbiddenError('Only the owner, an admin or the billing contact can change billing details.');
  }

  private accountView(a: BillingAccount, rate: number) {
    return {
      id: a.id,
      workspaceId: a.workspaceId,
      status: a.status,
      currency: a.currency,
      per100Minor: rate,
      negotiated: a.per100Minor !== null,
      minimumMinor: a.minimumMinor,
      creditLimit: a.creditLimit,
      netDays: a.netDays,
      graceDays: a.graceDays,
      billingEmail: a.billingEmail,
      billTo: (a.billTo ?? null) as BillTo | null,
      startedAt: a.startedAt,
      suspendedAt: a.suspendedAt,
      suspendedReason: a.suspendedReason,
      closedAt: a.closedAt,
      /** What 1,000 credits cost at this rate — the number people actually compare. */
      per1000Minor: priceCredits(1000, rate),
    };
  }

  private invoiceView(i: Invoice) {
    return {
      id: i.id,
      number: i.number,
      workspaceId: i.workspaceId,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      period: periodWords(i.periodStart),
      currency: i.currency,
      credits: i.credits,
      per100Minor: i.per100Minor,
      usageMinor: i.usageMinor,
      minimumMinor: i.minimumMinor,
      totalMinor: i.totalMinor,
      status: i.status,
      lines: (i.lines ?? []) as unknown as UsageLine[],
      billTo: (i.billTo ?? null) as BillTo | null,
      issuedAt: i.issuedAt,
      dueAt: i.dueAt,
      paidAt: i.paidAt,
      paidVia: i.paidVia,
      paidReference: i.paidReference,
      paymentId: i.paymentId,
      voidedAt: i.voidedAt,
      voidReason: i.voidReason,
      payable: (i.status === 'OPEN' || i.status === 'OVERDUE') && i.totalMinor > 0,
    };
  }
}

const VIA_WORDS: Record<string, string> = {
  FLUTTERWAVE: 'card or bank (Flutterwave)',
  PADDLE: 'card (Paddle)',
  STUB: 'test gateway',
  MANUAL: 'bank transfer',
  ZERO: 'nothing due',
};

export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(toMajor(minor, currency));
  } catch {
    return `${toMajor(minor, currency).toFixed(2)} ${currency}`;
  }
}

function periodWords(start: Date): string {
  return start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function dateWords(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function cleanBillTo(b: BillTo): BillTo {
  const out: BillTo = {};
  for (const k of ['company', 'address', 'taxId', 'contact'] as const) {
    const v = b[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
}

function joinNotes(existing: string | null, line: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return [existing?.trim(), `${stamp} ${line}`].filter(Boolean).join('\n');
}
