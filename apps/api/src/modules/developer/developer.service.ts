/**
 * The developer platform, as the portal sees it: projects, keys, webhook
 * endpoints and their deliveries, and usage rolled up from generations.
 *
 * A key is minted once, shown once and stored as a hash. Revoking is a
 * timestamp, never a delete: the generations it made point at it, and an
 * audit that cannot name the key is not one. Webhook secrets are stored as
 * written (they sign outbound bodies; nothing verifies inbound with them)
 * and shown once as well.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type ApiKey, type Project, type WebhookEndpoint } from '@prisma/client';
import type { Request } from 'express';
import { ConflictError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { authLog } from '../auth/auth.log';
import type { Actor } from '../auth/policy';
import { LedgerService } from '../ledger/ledger.service';
import { WebhookDispatcher } from './webhook.dispatcher';
import { DEFAULT_SCOPES, WEBHOOK_EVENTS, mintApiKey, mintWebhookSecret, type ApiScope } from './developer.types';
import type { CreateApiKeyDto, CreateProjectDto, CreateWebhookDto, UpdateProjectDto, UpdateWebhookDto } from './developer.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class DeveloperService {
  constructor(private readonly db: PrismaClient, private readonly ledger: LedgerService, private readonly dispatcher: WebhookDispatcher) {}

  // ---------------------------------------------------------------- projects

  async projects(workspaceId: string) {
    const rows = await this.db.project.findMany({ where: { workspaceId }, orderBy: [{ archivedAt: 'asc' }, { createdAt: 'asc' }], include: { _count: { select: { apiKeys: { where: { revokedAt: null } } } } } });
    return rows.map((p) => ({ ...this.projectView(p), activeKeys: p._count.apiKeys }));
  }

  async createProject(actor: Actor, workspaceId: string, dto: CreateProjectDto, req: Request) {
    const slug = await this.uniqueSlug(workspaceId, dto.name);
    const row = await this.db.project.create({ data: { workspaceId, name: dto.name.trim(), slug, description: dto.description?.trim() || null } });
    authLog('developer.project', 'succeeded', { userId: actor.userId, workspaceId, projectId: row.id, action: 'create' }, req);
    return this.projectView(row);
  }

  async updateProject(actor: Actor, workspaceId: string, projectId: string, dto: UpdateProjectDto, req: Request) {
    const row = await this.project(workspaceId, projectId);
    const updated = await this.db.project.update({
      where: { id: row.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
        ...(dto.archived !== undefined ? { archivedAt: dto.archived ? row.archivedAt ?? new Date() : null } : {}),
      },
    });
    authLog('developer.project', 'succeeded', { userId: actor.userId, workspaceId, projectId: row.id, action: dto.archived === true ? 'archive' : dto.archived === false ? 'restore' : 'update' }, req);
    return this.projectView(updated);
  }

  // ---------------------------------------------------------------- keys

  async keys(workspaceId: string, projectId?: string) {
    const rows = await this.db.apiKey.findMany({ where: { workspaceId, ...(projectId ? { projectId } : {}) }, orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }], include: { project: { select: { name: true, slug: true } }, createdBy: { select: { name: true, email: true } } } });
    return rows.map((k) => this.keyView(k));
  }

  /** The key is returned once, here, and never again. */
  async createKey(actor: Actor, workspaceId: string, dto: CreateApiKeyDto, req: Request) {
    const project = await this.project(workspaceId, dto.projectId);
    if (project.archivedAt) throw new ConflictError('That project is archived. Restore it before adding keys.');
    const active = await this.db.apiKey.count({ where: { workspaceId, revokedAt: null } });
    if (active >= 50) throw new ConflictError('Fifty active keys is the limit for a workspace. Revoke one first.');
    const env = process.env.APP_ENV === 'production' ? 'live' : 'test';
    const minted = mintApiKey(env);
    const scopes = (dto.scopes?.length ? dto.scopes : DEFAULT_SCOPES) as ApiScope[];
    const row = await this.db.apiKey.create({
      data: {
        workspaceId, projectId: project.id, createdById: actor.userId, name: dto.name.trim(), prefix: minted.prefix, hash: minted.hash, scopes,
        expiresAt: dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * DAY_MS) : null,
      },
      include: { project: { select: { name: true, slug: true } }, createdBy: { select: { name: true, email: true } } },
    });
    authLog('developer.key', 'succeeded', { userId: actor.userId, workspaceId, projectId: project.id, apiKeyId: row.id, prefix: row.prefix, scopes, action: 'create' }, req);
    return { ...this.keyView(row), key: minted.key };
  }

  async revokeKey(actor: Actor, workspaceId: string, keyId: string, req: Request) {
    const row = await this.db.apiKey.findFirst({ where: { id: keyId, workspaceId } });
    if (!row) throw new NotFoundError('API key');
    if (row.revokedAt) return this.keyView(await this.db.apiKey.findUniqueOrThrow({ where: { id: row.id }, include: { project: { select: { name: true, slug: true } }, createdBy: { select: { name: true, email: true } } } }));
    const updated = await this.db.apiKey.update({ where: { id: row.id }, data: { revokedAt: new Date() }, include: { project: { select: { name: true, slug: true } }, createdBy: { select: { name: true, email: true } } } });
    authLog('developer.key', 'succeeded', { userId: actor.userId, workspaceId, apiKeyId: row.id, prefix: row.prefix, action: 'revoke' }, req);
    return this.keyView(updated);
  }

  // ---------------------------------------------------------------- webhooks

  async webhooks(workspaceId: string) {
    const rows = await this.db.webhookEndpoint.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, include: { project: { select: { name: true, slug: true } } } });
    return rows.map((w) => this.webhookView(w));
  }

  /** The secret is returned once, here. */
  async createWebhook(actor: Actor, workspaceId: string, dto: CreateWebhookDto, req: Request) {
    if (dto.projectId) await this.project(workspaceId, dto.projectId);
    const count = await this.db.webhookEndpoint.count({ where: { workspaceId } });
    if (count >= 20) throw new ConflictError('Twenty endpoints is the limit for a workspace.');
    this.assertReachableUrl(dto.url);
    const row = await this.db.webhookEndpoint.create({
      data: { workspaceId, projectId: dto.projectId ?? null, url: dto.url, secret: mintWebhookSecret(), events: dto.events?.length ? dto.events : [...WEBHOOK_EVENTS] },
      include: { project: { select: { name: true, slug: true } } },
    });
    authLog('developer.webhook', 'succeeded', { userId: actor.userId, workspaceId, webhookId: row.id, action: 'create' }, req);
    return { ...this.webhookView(row), secret: row.secret };
  }

  async updateWebhook(actor: Actor, workspaceId: string, webhookId: string, dto: UpdateWebhookDto, req: Request) {
    const row = await this.webhook(workspaceId, webhookId);
    if (dto.url) this.assertReachableUrl(dto.url);
    const updated = await this.db.webhookEndpoint.update({
      where: { id: row.id },
      data: {
        ...(dto.url ? { url: dto.url } : {}),
        ...(dto.events ? { events: dto.events } : {}),
        ...(dto.active !== undefined ? { active: dto.active, ...(dto.active ? { failures: 0 } : {}) } : {}),
      },
      include: { project: { select: { name: true, slug: true } } },
    });
    authLog('developer.webhook', 'succeeded', { userId: actor.userId, workspaceId, webhookId: row.id, action: 'update' }, req);
    return this.webhookView(updated);
  }

  async deleteWebhook(actor: Actor, workspaceId: string, webhookId: string, req: Request) {
    const row = await this.webhook(workspaceId, webhookId);
    await this.db.webhookEndpoint.delete({ where: { id: row.id } });
    authLog('developer.webhook', 'succeeded', { userId: actor.userId, workspaceId, webhookId: row.id, action: 'delete' }, req);
    return { deleted: true };
  }

  /** A ping the developer asks for, delivered like any other event. */
  async testWebhook(actor: Actor, workspaceId: string, webhookId: string, req: Request) {
    const row = await this.webhook(workspaceId, webhookId);
    const delivery = await this.dispatcher.enqueue(row, 'ping', { message: 'Hello from AnyStudio. Your endpoint is wired up.', workspaceId, at: new Date().toISOString() });
    authLog('developer.webhook', 'succeeded', { userId: actor.userId, workspaceId, webhookId: row.id, action: 'test' }, req);
    const sent = await this.dispatcher.deliverOne(delivery.id);
    return { delivery: sent };
  }

  async deliveries(workspaceId: string, webhookId: string, take = 50) {
    const row = await this.webhook(workspaceId, webhookId);
    const rows = await this.db.webhookDelivery.findMany({ where: { endpointId: row.id }, orderBy: { createdAt: 'desc' }, take });
    return rows.map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, responseStatus: d.responseStatus, lastError: d.lastError, createdAt: d.createdAt, deliveredAt: d.deliveredAt, nextAttemptAt: d.status === 'PENDING' ? d.nextAttemptAt : null, payload: d.payload }));
  }

  async redeliver(workspaceId: string, webhookId: string, deliveryId: string) {
    await this.webhook(workspaceId, webhookId);
    const d = await this.db.webhookDelivery.findFirst({ where: { id: deliveryId, endpointId: webhookId } });
    if (!d) throw new NotFoundError('delivery');
    await this.db.webhookDelivery.update({ where: { id: d.id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
    return { delivery: await this.dispatcher.deliverOne(d.id) };
  }

  // ---------------------------------------------------------------- usage

  /** The last N days by day and capability, per project and per key, plus the balance — the portal's overview. */
  async usage(workspaceId: string, days = 30, projectId?: string) {
    const since = new Date(Date.now() - days * DAY_MS);
    const projectFilter = projectId ? Prisma.sql`AND g."projectId" = ${projectId}::uuid` : Prisma.empty;
    const [byDay, byProject, byKey, byMerchant, totals, wallet] = await Promise.all([
      this.db.$queryRaw<Array<{ day: Date; capability: string; requests: number; succeeded: number; failed: number; credits: number }>>`
        SELECT date_trunc('day', g."createdAt") AS "day", g.capability::text AS "capability", count(*)::int AS "requests",
               count(*) FILTER (WHERE g.status = 'SUCCEEDED')::int AS "succeeded", count(*) FILTER (WHERE g.status = 'FAILED')::int AS "failed",
               coalesce(sum(g.credits) FILTER (WHERE g.status = 'SUCCEEDED'), 0)::int AS "credits"
        FROM generations g
        WHERE g."workspaceId" = ${workspaceId}::uuid AND g.channel = 'API' AND g.kind <> 'CHILD' AND g."createdAt" >= ${since} ${projectFilter}
        GROUP BY 1, 2 ORDER BY 1`,
      this.db.$queryRaw<Array<{ projectId: string; name: string; requests: number; succeeded: number; credits: number; merchants: number }>>`
        SELECT p.id AS "projectId", p.name, count(g.id)::int AS "requests", count(g.id) FILTER (WHERE g.status = 'SUCCEEDED')::int AS "succeeded",
               coalesce(sum(g.credits) FILTER (WHERE g.status = 'SUCCEEDED'), 0)::int AS "credits", count(DISTINCT g."merchantRef")::int AS "merchants"
        FROM projects p LEFT JOIN generations g ON g."projectId" = p.id AND g.kind <> 'CHILD' AND g."createdAt" >= ${since}
        WHERE p."workspaceId" = ${workspaceId}::uuid GROUP BY p.id ORDER BY 3 DESC`,
      this.db.$queryRaw<Array<{ apiKeyId: string; name: string; prefix: string; requests: number; credits: number; lastUsedAt: Date | null }>>`
        SELECT k.id AS "apiKeyId", k.name, k.prefix, count(g.id)::int AS "requests", coalesce(sum(g.credits) FILTER (WHERE g.status = 'SUCCEEDED'), 0)::int AS "credits", k."lastUsedAt"
        FROM api_keys k LEFT JOIN generations g ON g."apiKeyId" = k.id AND g.kind <> 'CHILD' AND g."createdAt" >= ${since}
        WHERE k."workspaceId" = ${workspaceId}::uuid ${projectId ? Prisma.sql`AND k."projectId" = ${projectId}::uuid` : Prisma.empty} GROUP BY k.id ORDER BY 4 DESC`,
      this.db.$queryRaw<Array<{ merchantRef: string; requests: number; credits: number }>>`
        SELECT g."merchantRef", count(*)::int AS "requests", coalesce(sum(g.credits) FILTER (WHERE g.status = 'SUCCEEDED'), 0)::int AS "credits"
        FROM generations g
        WHERE g."workspaceId" = ${workspaceId}::uuid AND g.channel = 'API' AND g.kind <> 'CHILD' AND g."merchantRef" IS NOT NULL AND g."createdAt" >= ${since} ${projectFilter}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      this.db.$queryRaw<Array<{ requests: number; succeeded: number; failed: number; credits: number; merchants: number; p50: number | null }>>`
        SELECT count(*)::int AS "requests", count(*) FILTER (WHERE g.status = 'SUCCEEDED')::int AS "succeeded", count(*) FILTER (WHERE g.status = 'FAILED')::int AS "failed",
               coalesce(sum(g.credits) FILTER (WHERE g.status = 'SUCCEEDED'), 0)::int AS "credits", count(DISTINCT g."merchantRef")::int AS "merchants",
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (g."finishedAt" - g."createdAt"))) AS "p50"
        FROM generations g
        WHERE g."workspaceId" = ${workspaceId}::uuid AND g.channel = 'API' AND g.kind <> 'CHILD' AND g."createdAt" >= ${since} ${projectFilter}`,
      this.db.wallet.findUnique({ where: { workspaceId }, select: { id: true } }),
    ]);
    return {
      days, since,
      totals: { ...(totals[0] ?? { requests: 0, succeeded: 0, failed: 0, credits: 0, merchants: 0, p50: null }), p50Sec: totals[0]?.p50 ?? null },
      balance: wallet ? await this.ledger.balance(wallet.id) : 0,
      byDay: byDay.map((r) => ({ day: r.day.toISOString().slice(0, 10), capability: r.capability, requests: r.requests, succeeded: r.succeeded, failed: r.failed, credits: r.credits })),
      byProject, byKey, byMerchant,
    };
  }

  // ---------------------------------------------------------------- helpers

  private async project(workspaceId: string, projectId: string): Promise<Project> {
    const row = await this.db.project.findFirst({ where: { id: projectId, workspaceId } });
    if (!row) throw new NotFoundError('project');
    return row;
  }

  private async webhook(workspaceId: string, webhookId: string): Promise<WebhookEndpoint> {
    const row = await this.db.webhookEndpoint.findFirst({ where: { id: webhookId, workspaceId } });
    if (!row) throw new NotFoundError('webhook endpoint');
    return row;
  }

  private async uniqueSlug(workspaceId: string, name: string): Promise<string> {
    const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
    for (let i = 0; i < 20; i++) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      if (!(await this.db.project.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } }))) return slug;
    }
    throw new ConflictError('Too many projects share that name.');
  }

  /** No loopback, link-local or private targets: a webhook is not a way to reach our own network. */
  private assertReachableUrl(url: string): void {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { throw new ValidationError({ url: 'That is not a valid URL.' }); }
    const isProd = process.env.APP_ENV === 'production';
    const local = host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|fc|fd)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (local && isProd) throw new ValidationError({ url: 'The endpoint must be a public HTTPS address.' });
  }

  private projectView(p: Project) {
    return { id: p.id, name: p.name, slug: p.slug, description: p.description, createdAt: p.createdAt, archivedAt: p.archivedAt };
  }

  private keyView(k: ApiKey & { project: { name: string; slug: string }; createdBy: { name: string | null; email: string | null } }) {
    return { id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, project: { id: k.projectId, name: k.project.name, slug: k.project.slug }, createdBy: k.createdBy.name ?? k.createdBy.email, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, revokedAt: k.revokedAt };
  }

  private webhookView(w: WebhookEndpoint & { project: { name: string; slug: string } | null }) {
    return { id: w.id, url: w.url, events: w.events, active: w.active, failures: w.failures, lastDeliveryAt: w.lastDeliveryAt, project: w.project && w.projectId ? { id: w.projectId, name: w.project.name, slug: w.project.slug } : null, createdAt: w.createdAt };
  }
}
