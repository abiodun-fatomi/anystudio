/**
 * The dispatcher against a real local HTTP receiver and a fake store: the
 * body is signed and verifiable, a 2xx marks SENT, a 5xx schedules a retry
 * with backoff, and repeated failures pause the endpoint.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, WebhookDelivery, WebhookEndpoint } from '@prisma/client';
import { GenerationHooks } from '../generation/generation.hooks';
import type { MediaService } from '../media/media.service';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WEBHOOK_PAUSE_AFTER, verifyWebhook } from './developer.types';

let server: Server; let port = 0;
let mode: 'ok' | 'fail' = 'ok';
const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ headers: req.headers, body }); res.statusCode = mode === 'ok' ? 200 : 503; res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function fakeStore() {
  const endpoint: WebhookEndpoint = { id: 'e1', workspaceId: 'w1', projectId: null, url: `http://127.0.0.1:${port}/hook`, secret: 'whsec_test', events: [], active: true, failures: 0, lastDeliveryAt: null, createdAt: new Date() };
  const deliveries = new Map<string, WebhookDelivery>();
  const db = {
    webhookDelivery: {
      create: async ({ data }: { data: { endpointId: string; event: string; payload: unknown } }) => {
        const d: WebhookDelivery = { id: `d${deliveries.size + 1}`, endpointId: data.endpointId, event: data.event, payload: data.payload as never, status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), responseStatus: null, lastError: null, createdAt: new Date(), deliveredAt: null };
        deliveries.set(d.id, d); return d;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<WebhookDelivery> }) => { const d = { ...deliveries.get(where.id)!, ...data }; deliveries.set(d.id, d); return d; },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ ...deliveries.get(where.id)!, endpoint }),
      findMany: async () => [...deliveries.values()].filter((d) => d.status === 'PENDING' && d.nextAttemptAt <= new Date()).map((d) => ({ ...d, endpoint })),
    },
    webhookEndpoint: {
      update: async ({ data }: { data: Partial<WebhookEndpoint> }) => Object.assign(endpoint, data),
      findMany: async () => [endpoint],
    },
  } as unknown as PrismaClient;
  const media = { readUrls: async (_w: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, `https://signed/${k}`])) } as unknown as MediaService;
  return { db, endpoint, deliveries, dispatcher: new WebhookDispatcher(db, new GenerationHooks(), media) };
}

describe('WebhookDispatcher', () => {
  it('signs the body, delivers on 2xx, and the receiver can verify it', async () => {
    mode = 'ok';
    const { dispatcher, endpoint } = fakeStore();
    const d = await dispatcher.enqueue(endpoint, 'ping', { hello: 'world' });
    const sent = await dispatcher.deliverOne(d.id);
    expect(sent.status).toBe('SENT');
    expect(sent.responseStatus).toBe(200);
    const last = received.at(-1)!;
    expect(last.headers['x-anystudio-event']).toBe('ping');
    expect(verifyWebhook('whsec_test', last.body, String(last.headers['x-anystudio-signature']))).toBe(true);
    expect(JSON.parse(last.body)).toMatchObject({ type: 'ping', data: { hello: 'world' } });
    expect(endpoint.failures).toBe(0);
  });

  it('retries with backoff on failure and pauses the endpoint after repeated failures', async () => {
    mode = 'fail';
    const { dispatcher, endpoint } = fakeStore();
    const d = await dispatcher.enqueue(endpoint, 'generation.succeeded', { id: 'g1' });
    const first = await dispatcher.deliverOne(d.id);
    expect(first.status).toBe('PENDING');
    expect(first.attempts).toBe(1);
    expect(first.lastError).toBe('HTTP 503');
    expect(first.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(endpoint.failures).toBe(1);
    // Nothing is due yet, so the sweeper sends nothing.
    expect(await dispatcher.deliverDue()).toBe(0);
    for (let i = 1; i < WEBHOOK_PAUSE_AFTER; i++) await dispatcher.enqueue(endpoint, 'ping', {}).then((x) => dispatcher.deliverOne(x.id));
    expect(endpoint.active).toBe(false);
    expect(endpoint.failures).toBe(WEBHOOK_PAUSE_AFTER);
  });

  it('turns a finished API generation into one delivery per interested endpoint, with signed output URLs', async () => {
    mode = 'ok';
    const { dispatcher, deliveries } = fakeStore();
    const row = { id: 'g9', workspaceId: 'w1', projectId: 'p1', channel: 'API', kind: 'STANDALONE', status: 'SUCCEEDED', capability: 'IMAGE_EDIT', clientKey: 'c1', merchantRef: 'store-9', credits: 10, costCode: 'image.storefront', createdAt: new Date(), finishedAt: new Date(), outputs: [{ key: 'w1/x.png', role: 'image', mime: 'image/png' }, { key: 'w1/vault/song.mp3', role: 'audio', mime: 'audio/mpeg', locked: true }], failureKind: null } as never;
    await dispatcher.onGenerationFinished(row);
    const d = [...deliveries.values()][0]!;
    expect(d.event).toBe('generation.succeeded');
    const data = (d.payload as { data: { outputs: Array<{ key: string; url: string | null }> ; merchantRef: string } }).data;
    expect(data.merchantRef).toBe('store-9');
    expect(data.outputs[0]).toMatchObject({ key: 'w1/x.png', url: 'https://signed/w1/x.png' });
    expect(data.outputs[1]).toMatchObject({ key: '', url: null });
    // A web-studio generation is nobody's webhook.
    await dispatcher.onGenerationFinished({ ...(row as object), channel: 'WEB' } as never);
    expect(deliveries.size).toBe(1);
  });
});
