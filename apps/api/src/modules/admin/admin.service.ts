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
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type StaffRole } from '@prisma/client';
import type { Request } from 'express';
import { CAPABILITIES, MARKET_CURRENCIES, SCENE_PROVIDERS, PRESERVATION_POLICIES, templateThumbnailKey } from '@anystudio/shared';
import { ConflictError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { flutterwaveId, paddleId } from '../billing/billing-catalogue-readiness.service';
import { logger } from '../../../config/logger';
import { authLog } from '../auth/auth.log';
import { assertStaff, assertStaffMutation, type Actor } from '../auth/policy';
import { GenerationService } from '../generation/generation.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notification/notification.service';
import { ProviderRegistry } from '../provider/provider.registry';
import { ProviderRouter } from '../provider/provider.router';
import { MediaService } from '../media/media.service';
import { TemplateService } from '../template/template.service';
import type {
  AuditQueryDto,
  CataloguePatchDto,
  CreditsDto,
  GenerationsQueryDto,
  PaymentsQueryDto,
  PlatformMessageDto,
  PlanPatchDto,
  PlatformMessagePatchDto,
  PricePatchDto,
  ProviderPatchDto,
  SearchDto,
  StaffGrantDto,
  TemplateCreateDto,
  TemplatePatchDto,
  TemplateRenderDto,
  TemplateThumbnailDto,
} from './admin.dto';

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
    private readonly media: MediaService,
    private readonly templateCatalogue: TemplateService,
  ) {}

  // ---------------------------------------------------------------- overview

  async overview() {
    const now = Date.now();
    const day = new Date(now - DAY_MS);
    const week = new Date(now - 7 * DAY_MS);
    const month = new Date(now - 30 * DAY_MS);
    const [
      users,
      usersWeek,
      workspaces,
      genToday,
      failedToday,
      runningNow,
      queuedStale,
      paymentsMonth,
      providers,
      recentFailures,
      whatsappToday,
      apiToday,
      worker,
    ] = await Promise.all([
      this.db.user.count({ where: { status: { not: 'DELETED' } } }),
      this.db.user.count({ where: { createdAt: { gte: week } } }),
      this.db.workspace.groupBy({ by: ['type'], where: { deletedAt: null }, _count: { _all: true } }),
      this.db.generation.count({ where: { createdAt: { gte: day }, kind: { not: 'CHILD' } } }),
      this.db.generation.count({ where: { createdAt: { gte: day }, kind: { not: 'CHILD' }, status: 'FAILED' } }),
      this.db.generation.count({ where: { status: 'RUNNING' } }),
      this.db.generation.count({ where: { status: 'QUEUED', createdAt: { lt: new Date(now - 10 * 60_000) } } }),
      this.db.payment.aggregate({ where: { status: 'SUCCEEDED', createdAt: { gte: month } }, _sum: { credits: true }, _count: { _all: true } }),
      this.db.providerModel.findMany({ where: { enabled: true } }),
      this.db.generation.findMany({
        where: { status: 'FAILED', createdAt: { gte: day }, kind: { not: 'CHILD' } },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, capability: true, failureKind: true, failureReason: true, providerKey: true, workspaceId: true, createdAt: true },
      }),
      this.db.generation.count({ where: { createdAt: { gte: day }, channel: 'WHATSAPP' } }),
      this.db.generation.count({ where: { createdAt: { gte: day }, channel: 'API' } }),
      // The media encoder has its own heartbeat. It must not make the console
      // report the fast/heavy worker healthy when that service is down.
      this.db.workerHeartbeat.findFirst({ where: { service: 'worker' }, orderBy: { seenAt: 'desc' } }),
    ]);
    const breakers = providers.filter((p) => p.breakerOpenedAt && now - p.breakerOpenedAt.getTime() < 10 * 60_000);
    const missing = providers.filter((p) => !this.registry.get(p.key));
    return {
      users: { total: users, newThisWeek: usersWeek },
      workspaces: Object.fromEntries(workspaces.map((w) => [w.type, w._count._all])),
      generations: { today: genToday, failedToday, runningNow, queuedStale, whatsappToday, apiToday },
      credits: { soldLast30d: paymentsMonth._sum.credits ?? 0, paymentsLast30d: paymentsMonth._count._all },
      providers: {
        enabled: providers.length,
        breakersOpen: breakers.map((b) => `${b.key} (${b.capability})`),
        noAdapter: missing.map((m) => `${m.key} (${m.capability})`),
      },
      recentFailures,
      // A worker refreshes its row every thirty seconds; three misses means it is gone.
      worker: worker ? { seenAt: worker.seenAt, host: worker.host, version: worker.version, alive: now - worker.seenAt.getTime() < 90_000 } : null,
    };
  }

  /** Just the liveness, for pages that must not wait on the whole overview. */
  async workerStatus() {
    const worker = await this.db.workerHeartbeat.findFirst({ where: { service: 'worker' }, orderBy: { seenAt: 'desc' } });
    return worker ? { seenAt: worker.seenAt, host: worker.host, version: worker.version, alive: Date.now() - worker.seenAt.getTime() < 90_000 } : null;
  }

  // ---------------------------------------------------------------- customers

  async customers(q: SearchDto) {
    const term = q.q?.trim();
    const where: Prisma.UserWhereInput = term
      ? {
          OR: [
            { email: { contains: term, mode: 'insensitive' } },
            { phone: { contains: term.replace(/\s+/g, '') } },
            { name: { contains: term, mode: 'insensitive' } },
            ...(isUuid(term) ? [{ id: term }] : []),
          ],
        }
      : {};
    const rows = await this.db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.take ?? 50,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
        workspaceMembers: { select: { role: true, workspace: { select: { id: true, name: true, type: true } } } },
      },
    });
    return {
      customers: rows.map((u) => ({ ...u, workspaces: u.workspaceMembers.map((m) => ({ ...m.workspace, role: m.role })), workspaceMembers: undefined })),
      nextCursor: rows.length === (q.take ?? 50) ? rows[rows.length - 1]!.id : null,
    };
  }

  async customer(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        phoneIsWhatsApp: true,
        status: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        createdAt: true,
        lastLoginAt: true,
        deleteRequestedAt: true,
        locale: true,
        timezone: true,
        identities: { select: { provider: true, createdAt: true } },
        mfaFactors: { select: { type: true, confirmedAt: true } },
        staffGrants: { where: { revokedAt: null }, select: { role: true, expiresAt: true } },
      },
    });
    if (!user) throw new NotFoundError('customer');
    const memberships = await this.db.workspaceMember.findMany({
      where: { userId },
      include: { workspace: { include: { wallet: { select: { id: true } } } } },
    });
    const workspaces = await Promise.all(
      memberships.map(async (m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        type: m.workspace.type,
        currency: m.workspace.currency,
        role: m.role,
        deletedAt: m.workspace.deletedAt,
        balance: m.workspace.wallet ? await this.ledger.balance(m.workspace.wallet.id) : 0,
      })),
    );
    const [generations, payments, events] = await Promise.all([
      this.db.generation.findMany({
        where: { requestedById: userId, kind: { not: 'CHILD' } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          capability: true,
          status: true,
          credits: true,
          channel: true,
          providerKey: true,
          failureKind: true,
          createdAt: true,
          workspaceId: true,
          title: true,
        },
      }),
      this.db.payment.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      this.db.authEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, type: true, surface: true, ip: true, createdAt: true, detail: true },
      }),
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
    if (status === 'SUSPENDED')
      await this.db.session
        .updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'suspended' } })
        .catch(() => undefined);
    authLog('admin.customer', 'succeeded', { userId: actor.userId, target: userId, action: status.toLowerCase(), reason }, req);
    return { id: updated.id, status: updated.status };
  }

  // ---------------------------------------------------------------- workspaces and credits

  async workspace(workspaceId: string) {
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        wallet: { select: { id: true } },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
        subscriptions: { orderBy: { createdAt: 'desc' }, take: 3 },
        billingAccount: true,
      },
    });
    if (!ws) throw new NotFoundError('workspace');
    const [balance, ledger, generations] = await Promise.all([
      ws.wallet ? this.ledger.balance(ws.wallet.id) : 0,
      ws.wallet ? this.db.ledgerEntry.findMany({ where: { walletId: ws.wallet.id }, orderBy: { createdAt: 'desc' }, take: 50 }) : [],
      this.db.generation.findMany({
        where: { workspaceId, kind: { not: 'CHILD' } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, capability: true, status: true, credits: true, channel: true, providerKey: true, failureKind: true, createdAt: true, title: true },
      }),
    ]);
    return {
      workspace: {
        id: ws.id,
        name: ws.name,
        type: ws.type,
        currency: ws.currency,
        region: ws.region,
        profile: ws.profile,
        createdAt: ws.createdAt,
        deletedAt: ws.deletedAt,
      },
      balance,
      members: ws.members.map((m) => ({ role: m.role, ...m.user })),
      subscriptions: ws.subscriptions,
      billingAccount: ws.billingAccount,
      ledger,
      generations,
    };
  }

  /** Credits in or out, with a reason, on the record. */
  async adjustCredits(actor: Actor, workspaceId: string, dto: CreditsDto, req: Request) {
    assertStaffMutation(actor, { min: 'OPERATOR', workspaceId, stepUpMinutes: STEP_UP_MIN });
    if (dto.delta === 0) throw new ConflictError('Zero is not an adjustment.');
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId }, select: { id: true } });
    if (!wallet) throw new NotFoundError('wallet');
    const entry = await this.ledger.adjust({
      walletId: wallet.id,
      amount: Math.abs(dto.delta),
      delta: dto.delta,
      actorId: actor.userId,
      reason: dto.reason.trim(),
      idempotencyKey: `admin:${actor.userId}:${workspaceId}:${Date.now()}`,
    });
    authLog('admin.credits', 'succeeded', { userId: actor.userId, workspaceId, delta: dto.delta, reason: dto.reason, ledgerEntryId: entry.id }, req);
    const owner = await this.db.workspaceMember.findFirst({ where: { workspaceId, role: 'OWNER' }, select: { userId: true } });
    if (owner)
      void this.notifications.notify(owner.userId, {
        workspaceId,
        kind: 'CREDITS',
        title: dto.delta > 0 ? `${dto.delta.toLocaleString()} credits added by support` : `${Math.abs(dto.delta).toLocaleString()} credits removed by support`,
        body: dto.reason.trim(),
        href: '/billing',
        refId: entry.id,
      });
    return { entry, balance: await this.ledger.balance(wallet.id) };
  }

  // ---------------------------------------------------------------- generations

  async generations(q: GenerationsQueryDto) {
    const term = q.q?.trim();
    const where: Prisma.GenerationWhereInput = {
      kind: { not: 'CHILD' },
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.capability ? { capability: q.capability as never } : {}),
      ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
      ...(term
        ? {
            OR: [
              ...(isUuid(term) ? [{ id: term }, { workspaceId: term }] : []),
              { providerJobId: { contains: term } },
              { title: { contains: term, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const take = q.take ?? 50;
    const rows = await this.db.generation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        workspaceId: true,
        capability: true,
        status: true,
        credits: true,
        channel: true,
        providerKey: true,
        providerJobId: true,
        failureKind: true,
        failureReason: true,
        stage: true,
        attempts: true,
        providerCostMinor: true,
        createdAt: true,
        finishedAt: true,
        title: true,
      },
    });
    return { generations: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1]!.id : null };
  }

  async generation(id: string) {
    const row = await this.db.generation.findUnique({
      where: { id },
      include: {
        children: { orderBy: { createdAt: 'asc' } },
        workspace: { select: { name: true, type: true } },
        requestedBy: { select: { id: true, name: true, email: true, phone: true } },
      },
    });
    if (!row) throw new NotFoundError('generation');
    return row;
  }

  /** A row stuck RUNNING with a dead worker, or one the customer disputes: end it, credits back. */
  async failGeneration(actor: Actor, id: string, reason: string, req: Request) {
    const row = await this.db.generation.findUnique({ where: { id }, select: { id: true, status: true, workspaceId: true } });
    if (!row) throw new NotFoundError('generation');
    assertStaffMutation(actor, { min: 'OPERATOR', workspaceId: row.workspaceId, stepUpMinutes: STEP_UP_MIN });
    if (row.status !== 'RUNNING' && row.status !== 'QUEUED')
      throw new ConflictError(`That generation is ${row.status.toLowerCase()}; only a running or queued one can be ended.`);
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
    const entry = await this.ledger.refund({
      walletId: row.workspace.wallet.id,
      amount: row.credits,
      idempotencyKey: `goodwill:${row.id}`,
      referenceId: row.id,
      reason: `goodwill refund: ${reason}`,
    });
    authLog(
      'admin.generation',
      'succeeded',
      { userId: actor.userId, generationId: id, workspaceId: row.workspaceId, action: 'refund', credits: row.credits, reason, ledgerEntryId: entry.id },
      req,
    );
    void this.notifications.notify(row.requestedById, {
      workspaceId: row.workspaceId,
      kind: 'CREDITS',
      title: `${row.credits} credits refunded`,
      body: reason,
      href: '/billing',
      refId: `goodwill:${row.id}`,
    });
    return { entry };
  }

  // ---------------------------------------------------------------- providers and prices

  async providers() {
    const rows = await this.db.providerModel.findMany({ orderBy: [{ capability: 'asc' }, { priority: 'asc' }] });
    const now = Date.now();
    const usage = await this.db.generation.groupBy({
      by: ['providerKey'],
      where: { createdAt: { gte: new Date(now - DAY_MS) }, providerKey: { not: null } },
      _count: { _all: true },
    });
    const used = new Map(usage.map((u) => [u.providerKey, u._count._all]));
    return {
      capabilities: CAPABILITIES,
      providers: rows.map((r) => ({
        ...r,
        registered: Boolean(this.registry.get(r.key)),
        breakerOpen: Boolean(r.breakerOpenedAt && now - r.breakerOpenedAt.getTime() < 10 * 60_000),
        callsLast24h: used.get(r.key) ?? 0,
      })),
    };
  }

  async patchProvider(actor: Actor, key: string, capability: string, dto: ProviderPatchDto, req: Request) {
    assertStaffMutation(actor, { min: 'OPERATOR', stepUpMinutes: STEP_UP_MIN });
    const row = await this.db.providerModel.findUnique({ where: { key_capability: { key, capability: capability as never } } });
    if (!row) throw new NotFoundError('provider row');
    const sceneChange = dto.sceneAcceptance !== undefined || dto.scenePriority !== undefined;
    const preservationChange = dto.preservationUseCase !== undefined || dto.preservationAcceptance !== undefined;
    if (preservationChange) {
      const policy = PRESERVATION_POLICIES.find((p) => p.id === dto.preservationUseCase);
      if (!policy || policy.key !== key || policy.capability !== capability || dto.preservationAcceptance === undefined)
        throw new BadRequestException('Choose a supported use case and acceptance value');
      if (!dto.reason || dto.reason.trim().length < 4) throw new BadRequestException('A reason is required');
    }
    if (sceneChange) {
      if (!SCENE_PROVIDERS.some((p) => p.key === key && p.capability === capability)) throw new BadRequestException('Not a New Scene provider');
      if (dto.sceneAcceptance !== undefined && key !== SCENE_PROVIDERS[0].key)
        throw new BadRequestException('The shared acceptance setting belongs to the FLUX edit row');
      if (!dto.reason || dto.reason.trim().length < 4) throw new BadRequestException('A reason is required');
    }
    const config = {
      ...((row.config as Prisma.JsonObject) ?? {}),
      ...(dto.sceneAcceptance !== undefined ? { sceneAcceptance: dto.sceneAcceptance } : {}),
      ...(dto.scenePriority !== undefined ? { scenePriority: dto.scenePriority } : {}),
      ...(preservationChange
        ? {
            preservationAcceptance: {
              ...(((row.config as Prisma.JsonObject | null)?.preservationAcceptance as Prisma.JsonObject) ?? {}),
              [dto.preservationUseCase!]: dto.preservationAcceptance!,
            },
          }
        : {}),
    };
    const updated = await this.db.providerModel.update({
      where: { key_capability: { key, capability: capability as never } },
      data: {
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(sceneChange || preservationChange ? { config } : {}),
      },
    });
    authLog(
      'admin.provider',
      'succeeded',
      {
        userId: actor.userId,
        providerKey: key,
        capability,
        enabled: dto.enabled,
        priority: dto.priority,
        sceneAcceptance: dto.sceneAcceptance,
        scenePriority: dto.scenePriority,
        preservationUseCase: dto.preservationUseCase,
        preservationAcceptance: dto.preservationAcceptance,
        reason: dto.reason,
      },
      req,
    );
    logger.warn(
      { providerKey: key, capability, enabled: updated.enabled, priority: updated.priority, by: actor.userId },
      'provider row changed from the console',
    );
    return updated;
  }

  async resetBreaker(actor: Actor, key: string, capability: string, req: Request) {
    assertStaffMutation(actor, { min: 'OPERATOR', stepUpMinutes: STEP_UP_MIN });
    await this.db.providerModel.update({ where: { key_capability: { key, capability: capability as never } }, data: { breakerOpenedAt: null } });
    this.router.forget(key, capability as never);
    authLog('admin.provider', 'succeeded', { userId: actor.userId, providerKey: key, capability, action: 'reset_breaker' }, req);
    return { reset: true };
  }

  // -------------------------------------------------------------------------
  // The template catalogue.
  //
  // Every write here does two things that the other console writes do not:
  // it stamps `operatorEdited`, which permanently stops the seed overwriting
  // this row's copy and prompt, and it drops the studio's read memo so the
  // change is on the customer's screen on their next reload rather than up to
  // four minutes later. Forgetting either turns the console into theatre.
  // -------------------------------------------------------------------------

  /** Every template including the retired ones — the console has to be able to bring one back. */
  async templates() {
    return this.db.template.findMany({ orderBy: [{ category: 'asc' }, { sort: 'asc' }, { name: 'asc' }] });
  }

  async createTemplate(actor: Actor, dto: TemplateCreateDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const existing = await this.db.template.findUnique({ where: { code: dto.code }, select: { code: true } });
    if (existing) throw new ConflictError('a template with that code already exists');
    if (dto.kind === 'scene' && !dto.prompt?.trim()) throw new BadRequestException('a scene template needs a prompt');

    const created = await this.db.template.create({
      data: {
        code: dto.code,
        name: dto.name,
        note: dto.note,
        category: dto.category,
        kind: dto.kind,
        params: templateParams(dto.kind, dto.prompt),
        swatch: templateSwatch(dto.colors, dto.ink),
        keywords: dto.keywords?.trim() || null,
        ...(dto.sort === undefined ? {} : { sort: dto.sort }),
        // Born in the console, so the seed never owned it in the first place.
        operatorEdited: true,
      },
    });
    this.templateCatalogue.invalidate();
    authLog('admin.template', 'succeeded', { userId: actor.userId, code: dto.code, action: 'create', category: dto.category, reason: dto.reason }, req);
    return created;
  }

  async patchTemplate(actor: Actor, code: string, dto: TemplatePatchDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const row = await this.db.template.findUnique({ where: { code } });
    if (!row) throw new NotFoundError('template');

    // The prompt and the kind travel together: a template that is being made
    // into a scene needs words, and one being made into a cut must not keep
    // the old ones lying around where a later edit would resurrect them.
    const kind = dto.kind ?? (row.kind === 'cut' ? 'cut' : 'scene');
    const prompt = dto.prompt ?? currentPrompt(row.params);
    if (kind === 'scene' && !prompt.trim()) throw new BadRequestException('a scene template needs a prompt');

    const data: Prisma.TemplateUpdateInput = {
      ...(dto.name === undefined ? {} : { name: dto.name }),
      ...(dto.note === undefined ? {} : { note: dto.note }),
      ...(dto.category === undefined ? {} : { category: dto.category }),
      ...(dto.active === undefined ? {} : { active: dto.active }),
      ...(dto.sort === undefined ? {} : { sort: dto.sort }),
      ...(dto.keywords === undefined ? {} : { keywords: dto.keywords.trim() || null }),
      ...(dto.colors === undefined && dto.ink === undefined ? {} : { swatch: templateSwatch(dto.colors ?? currentColors(row.swatch), dto.ink) }),
      ...(dto.kind === undefined && dto.prompt === undefined ? {} : { kind, params: templateParams(kind, prompt) }),
      operatorEdited: true,
    };

    const updated = await this.db.template.update({ where: { code }, data });
    this.templateCatalogue.invalidate();
    authLog(
      'admin.template',
      'succeeded',
      {
        userId: actor.userId,
        code,
        action: 'update',
        changed: Object.keys(data).filter((k) => k !== 'operatorEdited'),
        wasActive: row.active,
        nowActive: updated.active,
        reason: dto.reason,
      },
      req,
    );
    return updated;
  }

  /**
   * Somewhere to put the example render.
   *
   * The key is derived from the template's code, never from anything the
   * caller sends, so this cannot be turned into a signature for an arbitrary
   * object. The row is pointed at the key immediately rather than after the
   * upload lands: a key with nothing behind it signs to a URL that 404s, and
   * `TemplateService` already treats an unreadable thumbnail as a tile that
   * falls back to its gradient. The alternative — a second confirming call —
   * is one more thing to fail halfway.
   */
  async templateThumbnailUpload(actor: Actor, code: string, dto: TemplateThumbnailDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const row = await this.db.template.findUnique({ where: { code }, select: { code: true } });
    if (!row) throw new NotFoundError('template');

    const ext = dto.mime === 'image/png' ? 'png' : dto.mime === 'image/jpeg' ? 'jpg' : 'webp';
    const key = templateThumbnailKey(code, ext);
    const signed = await this.media.presignRaw(key, dto.mime, dto.bytes);
    await this.db.template.update({ where: { code }, data: { thumbnailKey: key, operatorEdited: true } });
    this.templateCatalogue.invalidate();
    authLog('admin.template', 'succeeded', { userId: actor.userId, code, action: 'thumbnail', key, bytes: dto.bytes, reason: dto.reason }, req);
    return { ...signed, key };
  }

  /**
   * Copy a finished generation's picture onto a template's example key.
   *
   * Server-side, and deliberately: the bytes never touch the browser, so
   * there is no signed-URL fetch to be refused by CORS, and nothing can put
   * an arbitrary picture on a template — the only thing the caller chooses is
   * WHICH generation, and the key is still derived from the template's code.
   *
   * The generation must have succeeded and must carry an image. A song, a
   * reel or a half-finished job named here is a mistake worth saying out loud
   * rather than a blank tile discovered later.
   */
  async renderTemplateThumbnail(actor: Actor, code: string, dto: TemplateRenderDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const template = await this.db.template.findUnique({ where: { code }, select: { code: true } });
    if (!template) throw new NotFoundError('template');

    const generation = await this.db.generation.findUnique({
      where: { id: dto.generationId },
      select: { id: true, status: true, outputs: true, workspaceId: true, capability: true },
    });
    if (!generation) throw new NotFoundError('generation');
    if (generation.status !== 'SUCCEEDED') throw new BadRequestException(`that generation is ${generation.status.toLowerCase()}, not finished`);

    const outputs = Array.isArray(generation.outputs) ? (generation.outputs as Array<Record<string, unknown>>) : [];
    // The full-size picture, not a crop variant: a tile is judged on the
    // scene, and an export crop may have cut half of it away.
    const picture = outputs.find((o) => o.role === 'image') ?? outputs.find((o) => o.role === 'variant');
    const sourceKey = typeof picture?.key === 'string' ? picture.key : null;
    if (!sourceKey) throw new BadRequestException('that generation produced no picture');
    if (MediaService.isVault(sourceKey)) throw new BadRequestException('that output is locked');

    const bytes = await this.media.getBytes(sourceKey);
    // Stored as what it is. The picker sizes it with object-fit, so the tile
    // never depends on the render's own dimensions.
    const mime = typeof picture?.mime === 'string' ? picture.mime : 'image/png';
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const key = templateThumbnailKey(code, ext);
    await this.media.put(key, bytes, mime);
    await this.db.template.update({ where: { code }, data: { thumbnailKey: key, operatorEdited: true } });
    this.templateCatalogue.invalidate();
    authLog(
      'admin.template',
      'succeeded',
      { userId: actor.userId, code, action: 'render', generationId: generation.id, from: sourceKey, key, reason: dto.reason },
      req,
    );
    return { code, thumbnailKey: key, bytes: bytes.length };
  }

  async prices() {
    return this.db.creditCost.findMany({ orderBy: { code: 'asc' } });
  }

  // -------------------------------------------------------------- catalogue
  //
  // WHAT A PLAN AND A PACK COST, AND HOW THE GATEWAY KNOWS THEM
  //
  // `credit_costs` above is the INTERNAL price — credits per generation. This
  // is the money: what a subscription tier costs per market, what a one-off
  // credit pack costs, and the gateway's own identifiers for each.
  //
  // Those identifiers had no supported home. The seed deliberately does not
  // write them (they differ per environment, and a wrong one charges the wrong
  // amount), and the schema's comment claimed they were "set from the admin
  // console" — a screen that did not exist. So the only way to get a Paddle
  // price id into production was to open a shell on the database, and
  // BillingCatalogueReadinessService refuses to call production ready until
  // every active plan has one.
  //
  // Editing a price here does not disturb history: a Payment stores its own
  // amountMinor, currency and credits at the time it was taken, so old
  // invoices reconcile against themselves rather than against the row.

  async catalogue() {
    const [plans, packs] = await Promise.all([this.db.plan.findMany({ orderBy: { sort: 'asc' } }), this.db.creditPack.findMany({ orderBy: { sort: 'asc' } })]);
    return { plans, packs, markets: MARKET_CURRENCIES };
  }

  async patchPlan(actor: Actor, code: string, dto: PlanPatchDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const row = await this.db.plan.findUnique({ where: { code } });
    if (!row) throw new NotFoundError('plan');
    const data = catalogueUpdate(dto, { yearly: true });
    const updated = await this.db.plan.update({ where: { code }, data });
    authLog('admin.plan', 'succeeded', { userId: actor.userId, code, changed: Object.keys(data), reason: dto.reason }, req);
    return updated;
  }

  async patchPack(actor: Actor, code: string, dto: CataloguePatchDto, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const row = await this.db.creditPack.findUnique({ where: { code } });
    if (!row) throw new NotFoundError('credit pack');
    const data = catalogueUpdate(dto, { yearly: false });
    const updated = await this.db.creditPack.update({ where: { code }, data });
    authLog('admin.pack', 'succeeded', { userId: actor.userId, code, changed: Object.keys(data), reason: dto.reason }, req);
    return updated;
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
      where: {
        ...(q.status ? { status: q.status as never } : {}),
        ...(term
          ? { OR: [{ reference: { contains: term } }, { providerRef: { contains: term } }, ...(isUuid(term) ? [{ id: term }, { workspaceId: term }] : [])] }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return { payments: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1]!.id : null };
  }

  // ---------------------------------------------------------------- audit and staff

  async audit(q: AuditQueryDto) {
    const take = q.take ?? 100;
    const rows = await this.db.authEvent.findMany({
      where: { ...(q.userId ? { userId: q.userId } : {}), ...(q.type ? { type: q.type as never } : {}) },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { user: { select: { email: true, phone: true, name: true } } },
    });
    return { events: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1]!.id : null };
  }

  async staff() {
    const grants = await this.db.staffGrant.findMany({
      where: { revokedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true } }, grantedBy: { select: { name: true, email: true } } },
    });
    return grants.map((g) => ({
      id: g.id,
      role: g.role,
      reason: g.reason,
      expiresAt: g.expiresAt,
      createdAt: g.createdAt,
      user: g.user,
      grantedBy: g.grantedBy.name ?? g.grantedBy.email,
    }));
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
    const grant = await this.db.staffGrant.create({
      data: { userId: user.id, role, grantedById: actor.userId, reason: dto.reason.trim(), expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null },
    });
    authLog('admin.staff', 'succeeded', { userId: actor.userId, target: user.id, role, reason: dto.reason, action: 'grant' }, req);
    return grant;
  }

  async revokeStaff(actor: Actor, grantId: string, req: Request) {
    assertStaffMutation(actor, { min: 'ADMIN', stepUpMinutes: STEP_UP_MIN });
    const g = await this.db.staffGrant.findUnique({ where: { id: grantId } });
    if (!g || g.revokedAt) throw new NotFoundError('grant');
    if (g.userId === actor.userId) throw new ConflictError('Ask another admin to revoke your own access.');
    await this.db.staffGrant.update({ where: { id: grantId }, data: { revokedAt: new Date(), revokedById: actor.userId } });
    await this.db.session
      .updateMany({ where: { userId: g.userId, surface: 'ADMIN', revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'staff_revoked' } })
      .catch(() => undefined);
    authLog('admin.staff', 'succeeded', { userId: actor.userId, target: g.userId, action: 'revoke' }, req);
    return { revoked: true };
  }

  // ---------------------------------------------------------------- platform messages

  messages() {
    return this.notifications.platformMessages();
  }

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

/** A `cut` paints a colour and a `scene` describes a setting; nothing else is stored. */
function templateParams(kind: 'cut' | 'scene', prompt: string | undefined): Prisma.InputJsonValue {
  // A cut clears the prompt: the studio reads that field to decide whether
  // there is a setting to render at all.
  return kind === 'cut' ? { background: '#FFFFFF', prompt: '' } : { prompt: (prompt ?? '').trim() };
}

function templateSwatch(colors: string[] | undefined, ink: 'light' | 'dark' | undefined): Prisma.InputJsonValue {
  const picked = colors && colors.length > 0 ? colors.slice(0, 2) : ['#EFEBE4'];
  return { colors: picked, ink: ink ?? 'dark' };
}

function currentPrompt(params: Prisma.JsonValue): string {
  const raw = params !== null && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  return typeof raw.prompt === 'string' ? raw.prompt : '';
}

function currentColors(swatch: Prisma.JsonValue): string[] | undefined {
  const raw = swatch !== null && typeof swatch === 'object' && !Array.isArray(swatch) ? (swatch as Record<string, unknown>) : {};
  return Array.isArray(raw.colors) ? raw.colors.filter((c): c is string => typeof c === 'string') : undefined;
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * Turn a merge-patch into a Prisma update, refusing anything the checkout or
 * the readiness check would later choke on.
 *
 * Every rule here exists because the alternative surfaces somewhere worse: a
 * missing market throws at checkout for customers in that market only; a
 * malformed Paddle id is accepted by the console and then keeps
 * `/ready` degraded with no clue which row is at fault; a negative price is a
 * gateway error in a language nobody on the team reads.
 */
function catalogueUpdate(dto: CataloguePatchDto & { yearlyPriceByMarket?: Record<string, unknown> | null }, opts: { yearly: boolean }) {
  const bad: Record<string, string> = {};
  const data: Record<string, unknown> = {};

  if (dto.priceByMarket !== undefined) {
    const priced = money(dto.priceByMarket, bad, 'priceByMarket');
    if (priced) data.priceByMarket = priced;
  }
  if (opts.yearly && dto.yearlyPriceByMarket !== undefined) {
    if (dto.yearlyPriceByMarket === null) data.yearlyPriceByMarket = Prisma.DbNull;
    else {
      const priced = money(dto.yearlyPriceByMarket, bad, 'yearlyPriceByMarket');
      if (priced) data.yearlyPriceByMarket = priced;
    }
  }
  if (dto.providerRefs !== undefined) {
    const refs = gatewayRefs(dto.providerRefs, bad);
    if (refs) data.providerRefs = refs;
  }
  if (dto.active !== undefined) data.active = dto.active;
  if (dto.sort !== undefined) data.sort = dto.sort;

  if (Object.keys(bad).length) throw new ValidationError(bad);
  if (!Object.keys(data).length) throw new ValidationError({ patch: 'Nothing to change.' });
  return data;
}

/** Every market, a whole number of currency units, never negative. */
function money(value: Record<string, unknown>, bad: Record<string, string>, field: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const market of MARKET_CURRENCIES) {
    const raw = value[market];
    if (raw === undefined) {
      bad[`${field}.${market}`] = `A price for ${market} is required — a market with no price cannot be bought in.`;
      continue;
    }
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) bad[`${field}.${market}`] = 'Must be a number of currency units, zero or more.';
    else out[market] = n;
  }
  const extra = Object.keys(value).filter((k) => !MARKET_CURRENCIES.includes(k as never));
  if (extra.length) bad[field] = `Not a market we sell in: ${extra.join(', ')}.`;
  return Object.keys(bad).length ? null : out;
}

/**
 * The gateway's own ids, checked with the SAME predicates the readiness check
 * uses, so a value the console accepts can never be one production refuses.
 * An empty object clears the refs, which is how you take a plan off a gateway.
 */
function gatewayRefs(value: Record<string, unknown>, bad: Record<string, string>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [gateway, raw] of Object.entries(value)) {
    if (gateway !== 'paddle' && gateway !== 'flutterwave') {
      bad[`providerRefs.${gateway}`] = 'Only paddle and flutterwave have references.';
      continue;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      bad[`providerRefs.${gateway}`] = 'Expected { month, year } (a pack uses { once }).';
      continue;
    }
    const terms: Record<string, unknown> = {};
    for (const [term, id] of Object.entries(raw as Record<string, unknown>)) {
      if (term !== 'month' && term !== 'year' && term !== 'once') {
        bad[`providerRefs.${gateway}.${term}`] = 'Expected month, year or once.';
        continue;
      }
      const ok = gateway === 'paddle' ? paddleId(id, 'pri_') : flutterwaveId(id);
      if (!ok) {
        bad[`providerRefs.${gateway}.${term}`] =
          gateway === 'paddle' ? 'A Paddle price id looks like pri_01abc…' : 'A Flutterwave payment-plan id is a positive whole number.';
        continue;
      }
      terms[term] = typeof id === 'string' ? id.trim() : id;
    }
    out[gateway] = terms;
  }
  return Object.keys(bad).length ? null : out;
}
