/**
 * Outbound webhooks: what an organization's server hears when a generation
 * it asked for is done.
 *
 * Every delivery is a row first — the body as it will be signed — and only
 * then an HTTP call, so a crash between the two loses nothing and a replay
 * from the portal sends exactly what was signed. The deliverer runs from
 * the worker's timer: due rows, oldest first, a bounded batch, with a
 * doubling backoff from one minute and an endpoint paused after twenty
 * failures in a row (a dead endpoint should not be hit forever).
 *
 * The body is signed with `t=…,v1=…` over "<t>.<body>" (see signWebhook);
 * receivers verify with the secret shown once when the endpoint was made.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient, type Generation, type WebhookDelivery, type WebhookEndpoint } from '@prisma/client';
import { redactLocked } from '@anystudio/shared';
import { logger } from '../../../config/logger';
import { GenerationHooks } from '../generation/generation.hooks';
import { customerMessage } from '../generation/generation.service';
import { MediaService } from '../media/media.service';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_PAUSE_AFTER, signWebhook } from './developer.types';

const BATCH = 50;
const TIMEOUT_MS = 10_000;

@Injectable()
export class WebhookDispatcher implements OnModuleInit {
  private delivering = false;

  constructor(private readonly db: PrismaClient, private readonly hooks: GenerationHooks, private readonly media: MediaService) {}

  onModuleInit(): void {
    this.hooks.onFinished((row) => this.onGenerationFinished(row));
  }

  /** An API generation finished: one delivery per endpoint that wants to know. */
  async onGenerationFinished(row: Generation): Promise<void> {
    if (row.channel !== 'API' || row.kind === 'CHILD') return;
    const event = row.status === 'SUCCEEDED' ? 'generation.succeeded' : row.status === 'FAILED' ? 'generation.failed' : null;
    if (!event) return;
    const endpoints = await this.db.webhookEndpoint.findMany({ where: { workspaceId: row.workspaceId, active: true, OR: [{ projectId: null }, { projectId: row.projectId ?? undefined }] } });
    const wanted = endpoints.filter((e) => e.events.length === 0 || e.events.includes(event));
    if (wanted.length === 0) return;
    const payload = await this.generationPayload(row);
    for (const e of wanted) await this.enqueue(e, event, payload);
    logger.info({ generationId: row.id, event, endpoints: wanted.length }, 'webhook deliveries queued');
  }

  /** The row as the public API returns it, with fresh signed URLs (an hour; the body says so). */
  async generationPayload(row: Generation) {
    const outputs = redactLocked((row.outputs as Array<{ key: string; role: string; mime: string; bytes?: number; width?: number; height?: number; durationMs?: number; locked?: boolean; text?: unknown }> | null) ?? []);
    const keys = outputs.map((o) => o.key).filter(Boolean);
    const urls = keys.length ? await this.media.readUrls(row.workspaceId, keys).catch(() => ({} as Record<string, string>)) : {};
    return {
      id: row.id, status: row.status, capability: row.capability, clientKey: row.clientKey, merchantRef: row.merchantRef, projectId: row.projectId,
      credits: row.credits, costCode: row.costCode, createdAt: row.createdAt, finishedAt: row.finishedAt,
      outputs: outputs.map((o) => ({ ...o, url: o.key ? urls[o.key] ?? null : null })),
      urlsExpireInSec: 3600,
      ...(row.status === 'FAILED' ? { failure: { kind: row.failureKind, message: customerMessage(row) } } : {}),
    };
  }

  async enqueue(endpoint: WebhookEndpoint, event: string, data: unknown): Promise<WebhookDelivery> {
    const payload = { id: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, type: event, createdAt: new Date().toISOString(), data };
    return this.db.webhookDelivery.create({ data: { endpointId: endpoint.id, event, payload: payload as unknown as Prisma.InputJsonObject } });
  }

  /** Called from the worker's timer. Never overlaps itself. */
  async deliverDue(): Promise<number> {
    if (this.delivering) return 0;
    this.delivering = true;
    try {
      const due = await this.db.webhookDelivery.findMany({ where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } }, orderBy: { nextAttemptAt: 'asc' }, take: BATCH, include: { endpoint: true } });
      let sent = 0;
      for (const d of due) if ((await this.attempt(d, d.endpoint)).status === 'SENT') sent++;
      return sent;
    } catch (err) {
      logger.error({ err }, 'webhook deliverer failed');
      return 0;
    } finally {
      this.delivering = false;
    }
  }

  /** One delivery now, whatever its schedule says — the portal's test and replay. */
  async deliverOne(deliveryId: string): Promise<WebhookDelivery> {
    const d = await this.db.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { endpoint: true } });
    return this.attempt(d, d.endpoint);
  }

  private async attempt(d: WebhookDelivery, endpoint: WebhookEndpoint): Promise<WebhookDelivery> {
    const body = JSON.stringify(d.payload);
    const signature = signWebhook(endpoint.secret, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'AnyStudio-Webhooks/1', 'x-anystudio-signature': signature, 'x-anystudio-event': d.event, 'x-anystudio-delivery': d.id },
        body, signal: controller.signal, redirect: 'manual',
      });
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? (err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : err.message) : String(err);
    } finally {
      clearTimeout(timer);
    }

    const attempts = d.attempts + 1;
    if (!error) {
      const [row] = await Promise.all([
        this.db.webhookDelivery.update({ where: { id: d.id }, data: { status: 'SENT', attempts, responseStatus: status, lastError: null, deliveredAt: new Date() } }),
        this.db.webhookEndpoint.update({ where: { id: endpoint.id }, data: { failures: 0, lastDeliveryAt: new Date() } }),
      ]);
      logger.info({ deliveryId: d.id, endpointId: endpoint.id, event: d.event, attempts, status }, 'webhook delivered');
      return row;
    }

    const giveUp = attempts >= WEBHOOK_MAX_ATTEMPTS;
    const nextAttemptAt = new Date(Date.now() + 60_000 * 2 ** (attempts - 1));
    const failures = endpoint.failures + 1;
    const pause = failures >= WEBHOOK_PAUSE_AFTER;
    const [row] = await Promise.all([
      this.db.webhookDelivery.update({ where: { id: d.id }, data: { status: giveUp ? 'FAILED' : 'PENDING', attempts, responseStatus: status, lastError: error.slice(0, 500), nextAttemptAt } }),
      this.db.webhookEndpoint.update({ where: { id: endpoint.id }, data: { failures, lastDeliveryAt: new Date(), ...(pause ? { active: false } : {}) } }),
    ]);
    logger.warn({ deliveryId: d.id, endpointId: endpoint.id, event: d.event, attempts, status, err: error, giveUp, paused: pause, nextAttemptAt: giveUp ? null : nextAttemptAt }, pause ? 'webhook endpoint paused after repeated failures' : giveUp ? 'webhook delivery abandoned' : 'webhook delivery failed; will retry');
    return row;
  }
}
