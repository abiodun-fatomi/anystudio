/**
 * The staff console's reads and writes. Reads are wide and fast — the
 * console exists so support can answer a question without a database
 * client. Writes are few, each goes through `assertStaffMutation` (rank,
 * no self-dealing, a recent second factor), each needs a reason, and each
 * lands in the auth log so the story is told: who did what to whom and
 * why.
 *
 * Nothing here bypasses the product's own rules: credits move through the
 * ledger function, refunds claw back through it, a suspended user is a
 * status the guard already honours.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type StaffRole } from '@prisma/client';
import type { Request } from 'express';
import { CAPABILITIES } from '@anystudio/shared';
import { ConflictError, NotFoundError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { authLog } from '../auth/auth.log';
import { assertStaff, assertStaffMutation, type Actor } from '../auth/policy';
import { GenerationService } from '../generation/generation.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notification/notification.service';
import { ProviderRegistry } from '../provider/provider.registry';
import { ProviderRouter } from '../provider/provider.router';
import type { AuditQueryDto, CreditsDto, GenerationsQueryDto, PaymentsQueryDto, PlatformMessageDto, PlatformMessagePatchDto, PricePatchDto, ProviderPatchDto, SearchDto, StaffGrantDto } from './admin.dto';

const DAY_MS = 86_400_000;
/** Staff mutations accept a factor confirmed within the last half hour; the console re-prompts after that. */
const STEP_UP_MIN = 30;

@Injectable()
export class AdminService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly generationService: GenerationService,
    private readonly registry: ProviderRegistry,
    private readonly router: ProviderRouter,
    private readonly notifications: NotificationService,
  ) {}

  // ---------------------------------------------------------------- overview

  async overview() {
    const now = Date.now();
    const day = new Date(now - DAY_MS); const week = new Date(now - 7 * DAY_MS); const month = new Date(now - 30 * DAY_MS);
    const [users, usersWeek, workspaces, genToday, failedToday, runningNow, queuedStale, paymentsMonth, providers, recentFailures, whatsappToday, apiToday] = await Promise.all([
      this.db.user.count({ where: { status: { not: 'DELETED' } } }),
      this.db.user.count({ where: { createdAt: { gte: week } } }),
      this.db.workspace.groupBy({ by: ['type'], where: { deletedAt: null }, _count: { _all: true } }),
      this.db.generation.count({ where: { createdAt: { gte: day }, kind: { not: 'CHILD' } } }),
      this.db.generation.count({ where: { createdAt: { gte: day }, kind: { not: 'CHILD' }, status: 'FAILED' } }),
      this.db.generation.count({ where: { status: 'RUNNING' } }),
      this.db.generation.count({ where: { status: 'QUEUED', createdAt: { lt: new Date(now - 10 * 60_000) } } }),
      this.db.payment.aggregate({ where: { status: 'SUCCEEDED', createdAt: { gte: month } }, _sum: { credits: true }, _count: { _all: true } }),
      this.db.providerModel.findMany({ where: { enabled: true } }),
      this.db.generation.findMany({ where: { status: 'FAILED', createdAt: { gte: day }, kind: { not: 'CHILD' } }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, capability: true, failureKind: true, failureReason: true, providerKey: true, workspaceId: true, createdAt: true } }),
      this.db.generation.count({ where: { createdAt: { gte: day }, channel: 'WHATSAPP' } }),
      this.db.generation.count({ where: { createdAt: { gte: day }, channel: 'API' } }),
    ]);
    const breakers = providers.filter((p) => p.breakerOpenedAt && now - p.breakerOpenedAt.getTime() < 10 * 60_000);
    const missing = providers.filter((p) => !this.registry.get(p.key));
    return {
      users: { total: users, newThisWeek: usersWeek },
      workspaces: Object.fromEntries(workspaces.map((w) => [w.type, w._count._all])),
      generations: { today: genToday, failedToday, runningNow, queuedStale, whatsappToday, apiToday },
      credits: { soldLast30d: paymentsMonth._sum.credits ?? 0, paymentsLast30d: paymentsMonth._count._all },
      providers: { enabled: providers.length, breakersOpen: breakers.map((b) => `${b.key} (${b.capability})`), noAdapter: missing.map((m) => `${m.key} (${m.capability})`) },
      recentFailures,
    };
  }

  // ---------------------------------------------------------------- customers

  async customers(q: SearchDto) {
    const term = q.q?.trim();
    const where: Prisma.UserWhereInput = term
      ? { OR: [{ email: { contains: term, mode: 'insensitive' } }, { phone: { contains: term.replace(/\s+/g, '') } }, { name: { contains: term, mode: 'insensitive' } }, ...(isUuid(term) ? [{ id: term }] : [])] }
      : {};
    const rows = await this.db.user.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.take ?? 50, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}), select: { id: true, name: true, email: true, phone: true, status: true, createdAt: true, lastLoginAt: true, workspaceMembers: { select: { role: true, workspace: { select: { id: true, name: true, type: true } } } } } });
    return { customers: rows.map((u) => ({ ...u, workspaces: u.workspaceMembers.map((m) => ({ ...m.workspace, role: m.role })), workspaceMembers: undefined })), nextCursor: rows.length === (q.take ?? 50) ? rows[rows.length - 1]!.id : null };
  }

  async customer(userId: string) {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, phone: true, phoneIsWhatsApp: true, status: true, emailVerifiedAt: true, phoneVerifiedAt: true, createdAt: true, lastLoginAt: true, deleteRequestedAt: true, locale: true, timezone: true, identities: { select: { provider: true, createdAt: true } }, mfaFactors: { select: { type: true, confirmedAt: true } }, staffGrants: { where: { revokedAt: null }, select: { role: true, expiresAt: true } } } });
    if (!user) throw new NotFoundError('customer');
    const memberships = await this.db.workspaceMember.findMany({ where: { userId }, include: { workspace: { include: { wallet: { select: { id: true } } } } } });
    const workspaces = await Promise.all(memberships.map(async (m) => ({ id: m.workspace.id, name: m.workspace.name, type: m.workspace.type, currency: m.workspace.currency, role: m.role, deletedAt: m.workspace.deletedAt, balance: m.workspace.wallet ? await this.ledger.balance(m.workspace.wallet.id) : 0 })));
    const [generations, payments, events] = await Promise.all([
      this.db.generation.findMany({ where: { requestedById: userId, kind: { not: 'CHILD' } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, capability: true, status: true, credits: true, channel: true, providerKey: true, failureKind: true, createdAt: true, workspaceId: true, title: true } }),
      this.db.payment.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      this.db.authEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, type: true, surface: true, ip: true, createdAt: true, detail: true } }),
    ]);
    return { user, workspaces, generations, payments, events };
  }

  async setCustomerStatus(actor: Actor, userId: string, status: 'ACTIVE' | 'SUSPENDED', reason: string, req: Request) {
    assertStaffMutation(actor, { min: 'OPERATOR', stepUpMinutes: STEP_UP_MIN });
    if (userId === actor.userId) throw new ConflictError('You cannot change your own account from the console.');
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
    if (!user) throw new NotFoundError('customer');
    if (user.status === 'DELETED') throw new ConflictError('That account is deleted.');
    const updated = await this.db.user.update({ where: { id: userId }, data: { status } });
    if (status === 'SUSPENDED') await this.db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'suspended' } }).catch(() => undefined);
    authLog('admin.customer', 'succeeded', { userId: actor.userId, target: userId, action: status.toLowerCase(), reason }, req);
    return { id: updated.id, status: updated.status };
  }

  // ---------------------------------------------------------------- workspaces and credits

  async workspace(workspaceId: string) {
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, include: { wallet: { select: { id: true } }, members: { include: { user: { select: { id: true, name: true, email: true } } } }, subscriptions: { orderBy: { createdAt: 'desc' }, take: 3 } } });
    if (!ws) throw new NotFoundError('workspace');
    const [balance, ledger, generations] = await Promise.all([
      ws.wallet ? this.ledger.balance(ws.wallet.id) : 0,
      ws.wallet ? this.db.ledgerEntry.findMany({ where: { walletId: ws.wallet.id }, orderBy: { createdAt: 'desc' }, take: 50 }) : [],
      this.db.generation.findMany({ where: { workspaceId, kind: { not: 'CHILD' } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, capability: true, status: true, credits: true, channel: true, providerKey: true, failureKind: true, createdAt: true, title: true } }),
    ]);
    return { workspace: { id: ws.id, name: ws.name, type: ws.type, currency: ws.currency, region: ws.region, profile: ws.profile, createdAt: ws.createdAt, deletedAt: ws.deletedAt }, balance, members: ws.members.map((m) => ({ role: m.role, ...m.user })), subscriptions: ws.subscriptions, ledger, generations };
  }

  /** Credits in or out, with a reason, on the record. */
  async adjustCredits(actor: Actor, workspaceId: string, dto: CreditsDto, req: Request) {
    assertStaffMutation(actor, { min: 'OPERATOR', workspaceId, stepUpMinutes: STEP_UP_MIN });
    if (dto.delta === 0) throw new ConflictError('Zero is not an adjustment.');
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId }, select: { id: true } });
    if (!wallet) throw new NotFoundError('wallet');
    const entry = await this.ledger.adjust({ walletId: wallet.id, amount: Math.abs(dto.delta), delta: dto.delta, actorId: actor.userId, reason: dto.reason.trim(), idempotencyKey: `admin:${actor.userId}:${workspaceId}:${Date.now()}` });
    authLog('admin.credits', 'succeeded', { userId: actor.userId, workspaceId, delta: dto.delta, reason: dto.reason, ledgerEntryId: entry.id }, req);
    const owner = await this.db.workspaceMember.findFirst({ where: { workspaceId, role: 'OWNER' }, select: { userId: true } });
    if (owner) void this.notifications.notify(owner.userId, { workspaceId, kind: 'CREDITS', title: dto.delta > 0 ? `${dto.delta.toLocaleString()} credits added by support` : `${Math.abs(dto.delta).toLocaleString()} credits removed by support`, body: dto.reason.trim(), href: '/billing', refId: entry.id });
    return { entry, balance: await this.ledger.balance(wallet.id) };
  }

  // ---------------------------------------------------------------- generations

  async generations(q: GenerationsQueryDto) {
    const term = q.q?.trim();
    const where: Prisma.GenerationWhereInput = {
      kind: { not: 'CHILD' },
      ...(q.status ? { status: q.status as never } : {}), ...(q.capability ? { capability: q.capability as never } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
      ...(term ? { OR: [...(isUuid(term) ? [{ id: term }, { workspaceId: term }] : []), { providerJobId: { contains: term } }, { title: { contains: term, mode: 'insensitive' as const } }] } : {}),
    };
    const take = q.take ?? 50;
    const rows = await this.db.generation.findMany({ where, orderBy: { createdAt: 'desc' }, take: take + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}), select: { id: true, workspaceId: true, capability: true, status: true, credits: true, channel: true, providerKey: true, providerJobId: true, failureKind: true, failureReason: true, stage: true, attempts: true, providerCostMinor: true, createdAt: true, finishedAt: true, title: true } });
    return { generations: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1]!.id : null };
  }

  async generation(id: string) {
    const row = await this.db.generation.findUnique({ where: { id }, include: { children: { orderBy: { createdAt: 'asc' } }, workspace: { select: { name: true, type: true } }, requestedBy: { select: { id: true, name: true, email: true, phone: true } } } });
    if (!row) throw new NotFoundError('generation');
    return row;
  }

  /** A row stuck RUNNING with a dead worker, or one the customer disputes: end it, credits back. */
  async failGeneration(actor: Actor, id: string, reason: string, req: Request) {
    const row = await this.db.generation.findUnique({ where: { id }, select: { id: true, status: true, workspaceId: true } });
    if (!row) throw new NotFoundError('generation');
    assertStaffMutation(actor, { min: 'OPERATOR', workspaceId: row.workspaceId, stepUpMinutes: STEP_UP_MIN });
    if (row.status !== 'RUNNING' && row.status !== 'QUEUED') throw new ConflictError(`That generation is ${row.status.toLowerCase()}; only a running or queued one can be ended.`);
    const done = await this.generationService.fail(id, { failureReason: `ended by staff: ${reason}`, failureKind: 'INTERNAL' });
    authLog('admin.generation', 'succeeded', { userId: actor.userId, generationId: id, workspaceId: row.workspaceId, action: 'fail', reason }, req);
    return done;
  }

  /** Give the credits back on a finished row the customer is unhappy with, without touching the outputs. */
  async refundGeneration(actor: Actor, id: string, reason: string, req: Request) {
    const row = await this.db.generation.findUnique({ where: { id }, include: { workspace: { include: { wallet: { select: { id: true } } } } } });
    if (!row) throw new NotFoundError('generation');
    assertStaffMutation(actor, { min: 'OPERATOR', workspaceId: row.workspaceId, stepUpMinutes: STEP_UP_MIN });
    if (row.status !== 'SUCCEEDED') throw new ConflictError('Only a finished generation can be refunded as goodwill; a failed one already was.');
    if (!row.credits || !row.workspace.wallet) throw new ConflictError('There is nothing to refund on that row.');
    const entry = await this.ledger.refund({ walletId: row.workspace.wallet.id, amount: row.credits, idempotencyKey: `goodwill:${row.id}`, referenceId: row.id, reason: `goodwill refund: ${reason}` });
    authLog('admin.generation', 'succeeded', { userId: actor.userId, generationId: id, workspaceId: row.workspaceId, action: 'refund', credits: row.credits, reason, ledgerEntryId: entry.id }, req);
    void this.notifications.notify(row.requestedById, { workspaceId: row.workspaceId, kind: 'CREDITS', title: `${row.credits} credits refunded`, body: reason, href: '/billing', refId: `goodwill:${row.id}` });
    return { entry };
  }

  // ---------------------------------------------------------------- providers and prices

  async providers() {
    const rows = await this.db.providerModel.findMany({ orderBy: [{ capability: 'asc' }, { priority: 'asc' }] });
    const now = Date.now();
    const usage = await this.db.generation.groupBy({ by: ['providerKey'], where: { createdAt: { gte: new Date(now - DAY_MS) }, providerKey: { not: null } }, _count: { _all: true } });
    const used = new Map(usage.map((u) => [u.providerKey, u._count._all]));
    return {
      capabilities: CAPABILITIES,
      providers: rows.map((r) => ({ ...r, registered: Boolean(this.registry.get(r.key)), breakerOpen: Boolean(r.breakerOpenedAt && now - r.breakerOpenedAt.getTime() < 10 * 60_000), callsLast24h: used.get(r.key) ?? 0 })),
    };
  }

  async patchProvider(actor: Actor, key: string, capability: string, dto: ProviderPatchDto, req: Request) {
    assertStaffMutation(actor, { min: 'OPERATOR', stepUpMinutes: STEP_UP_MIN });
    const row = await this.db.providerModel.findUnique({ where: { key_capability: { key, capability: capability as never } } });
    if (!row) throw new NotFoundError('provider row');
    const updated = await this.db.providerModel.update({ where: { key_capability: { key, capability: capability as never } }, data: { ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}), ...(dto.priority !== undefined ? { priority: dto.priority } : {}) } });
    authLog('admin.provider', 'succeeded', { userId: actor.userId, providerKey: key, capability, enabled: dto.enabled, priority: dto.priority, reason: dto.reason }, req);
    logger.warn({ providerKey: key, capability, enabled: updated.enabled, priority: updated.priority, by: actor.userId }, 'provider row changed from the console');
    return updated;
  }

  async resetBreaker(actor: Actor, key: string, capability: string, req: Request) {
    assertStaffMutation(actor, { min: 'OPERATOR', stepUpMinutes: STEP_UP_MIN });
    await this.db.providerModel.update({ where: { key_capability: { key, capability: capability as never } }, data: { breakerOpenedAt: null } });
    this.router.forget(key, capability as never);
    authLog('admin.provider', 'succeeded', { userId: actor.userId, providerKey: key, capability, action: 'reset_breaker' }, req);
    return { reset: true };
  }

  async prices() {
    return this.db.creditCost.findMany({ orderBy: { code: 'asc' } });
  }

  async patchPrice(actor: Actor, code: string, dto: PricePatchDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const row = await this.db.creditCost.findUnique({ where: { code } });
    if (!row) throw new NotFoundError('price');
    const updated = await this.db.creditCost.update({ where: { code }, data: { credits: dto.credits } });
    authLog('admin.price', 'succeeded', { userId: actor.userId, code, from: row.credits, to: dto.credits, reason: dto.reason }, req);
    return updated;
  }

  // ---------------------------------------------------------------- payments

  async payments(q: PaymentsQueryDto) {
    const term = q.q?.trim();
    const take = q.take ?? 50;
    const rows = await this.db.payment.findMany({
      where: { ...(q.status ? { status: q.status as never } : {}), ...(term ? { OR: [{ reference: { contains: term } }, { providerRef: { contains: term } }, ...(isUuid(term) ? [{ id: term }, { workspaceId: term }] : [])] } : {}) },
      orderBy: { createdAt: 'desc' }, take: take + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return { payments: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1]!.id : null };
  }

  /** Mark refunded here after refunding at the gateway; the credits are clawed back, into the negative if they were spent. */
  async refundPayment(actor: Actor, id: string, reason: string, req: Request) {
    const p = await this.db.payment.findUnique({ where: { id }, include: { workspace: { include: { wallet: { select: { id: true } } } } } });
    if (!p) throw new NotFoundError('payment');
    assertStaffMutation(actor, { min: 'OPERATOR', workspaceId: p.workspaceId, stepUpMinutes: STEP_UP_MIN });
    if (p.status !== 'SUCCEEDED') throw new ConflictError(`That payment is ${p.status.toLowerCase()}.`);
    if (!p.workspace.wallet) throw new NotFoundError('wallet');
    const entry = await this.ledger.clawback({ walletId: p.workspace.wallet.id, amount: p.credits, idempotencyKey: `payment:${p.id}`, referenceId: p.id, reason: `refund: ${reason}` });
    const updated = await this.db.payment.update({ where: { id }, data: { status: 'REFUNDED', failureReason: `refunded by staff: ${reason}` } });
    authLog('admin.payment', 'succeeded', { userId: actor.userId, paymentId: id, workspaceId: p.workspaceId, credits: p.credits, reason, ledgerEntryId: entry.id }, req);
    return updated;
  }

  // ---------------------------------------------------------------- audit and staff

  async audit(q: AuditQueryDto) {
    const take = q.take ?? 100;
    const rows = await this.db.authEvent.findMany({ where: { ...(q.userId ? { userId: q.userId } : {}), ...(q.type ? { type: q.type as never } : {}) }, orderBy: { createdAt: 'desc' }, take: take + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}), include: { user: { select: { email: true, phone: true, name: true } } } });
    return { events: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1]!.id : null };
  }

  async staff() {
    const grants = await this.db.staffGrant.findMany({ where: { revokedAt: null }, orderBy: { createdAt: 'desc' }, include: { user: { select: { id: true, name: true, email: true } }, grantedBy: { select: { name: true, email: true } } } });
    return grants.map((g) => ({ id: g.id, role: g.role, reason: g.reason, expiresAt: g.expiresAt, createdAt: g.createdAt, user: g.user, grantedBy: g.grantedBy.name ?? g.grantedBy.email }));
  }

  async grantStaff(actor: Actor, dto: StaffGrantDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const role = dto.role as StaffRole;
    if (role === 'SUPERADMIN') assertStaff(actor, 'SUPERADMIN');
    const user = await this.db.user.findUnique({ where: { email: dto.email.toLowerCase() }, select: { id: true } });
    if (!user) throw new NotFoundError('a user with that email');
    if (user.id === actor.userId) throw new ConflictError('Nobody grants themselves staff access.');
    const existing = await this.db.staffGrant.findFirst({ where: { userId: user.id, revokedAt: null } });
    if (existing) await this.db.staffGrant.update({ where: { id: existing.id }, data: { revokedAt: new Date(), revokedById: actor.userId } });
    const grant = await this.db.staffGrant.create({ data: { userId: user.id, role, grantedById: actor.userId, reason: dto.reason.trim(), expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null } });
    authLog('admin.staff', 'succeeded', { userId: actor.userId, target: user.id, role, reason: dto.reason, action: 'grant' }, req);
    return grant;
  }

  async revokeStaff(actor: Actor, grantId: string, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const g = await this.db.staffGrant.findUnique({ where: { id: grantId } });
    if (!g || g.revokedAt) throw new NotFoundError('grant');
    if (g.userId === actor.userId) throw new ConflictError('Ask another admin to revoke your own access.');
    await this.db.staffGrant.update({ where: { id: grantId }, data: { revokedAt: new Date(), revokedById: actor.userId } });
    await this.db.session.updateMany({ where: { userId: g.userId, surface: 'ADMIN', revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'staff_revoked' } }).catch(() => undefined);
    authLog('admin.staff', 'succeeded', { userId: actor.userId, target: g.userId, action: 'revoke' }, req);
    return { revoked: true };
  }

  // ---------------------------------------------------------------- platform messages

  messages() { return this.notifications.platformMessages(); }

  async createMessage(actor: Actor, dto: PlatformMessageDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const m = await this.notifications.createPlatformMessage(actor.userId, dto);
    authLog('admin.message', 'succeeded', { userId: actor.userId, messageId: m.id, action: 'create', published: Boolean(dto.publish) }, req);
    return m;
  }

  async updateMessage(actor: Actor, id: string, dto: PlatformMessagePatchDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const m = await this.notifications.updatePlatformMessage(id, dto);
    authLog('admin.message', 'succeeded', { userId: actor.userId, messageId: id, action: 'update', published: dto.published }, req);
    return m;
  }

  async deleteMessage(actor: Actor, id: string, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    await this.notifications.deletePlatformMessage(id);
    authLog('admin.message', 'succeeded', { userId: actor.userId, messageId: id, action: 'delete' }, req);
    return { deleted: true };
  }
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
