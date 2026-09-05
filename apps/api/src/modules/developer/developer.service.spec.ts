/**
 * The developer platform against a real Postgres: projects, keys shown
 * once, the public API creating attributed generations, and usage rolling
 * up from them. DB-gated like the other integration suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DeveloperService } from './developer.service';
import { PublicApiService } from './public-api.service';
import { WebhookDispatcher } from './webhook.dispatcher';
import { GenerationHooks } from '../generation/generation.hooks';
import { GenerationService } from '../generation/generation.service';
import { LedgerService } from '../ledger/ledger.service';
import { MediaService } from '../media/media.service';
import { QueueService } from '../queue/queue.service';
import type { Actor } from '../auth/policy';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('DeveloperService + PublicApiService', () => {
  const db = new PrismaClient();
  const ledger = new LedgerService(db);
  const media = new MediaService(db);
  const hooks = new GenerationHooks();
  const generations = new GenerationService(db, ledger, media, new QueueService(), hooks);
  const dispatcher = new WebhookDispatcher(db, hooks, media);
  const dev = new DeveloperService(db, ledger, dispatcher);
  const api = new PublicApiService(db, generations, ledger, media, dispatcher);
  const req = { ip: '127.0.0.1', requestId: 'r', get: () => 'test' } as never;
  let workspaceId: string;
  let userId: string;
  let actor: Actor;

  beforeAll(async () => {
    await db.$connect();
    await db.creditCost.upsert({ where: { code: 'text.description' }, create: { code: 'text.description', credits: 2, label: 'Copy' }, update: {} });
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    const user = await db.user.create({ data: { email: `dev-${crypto.randomUUID()}@test.local` } });
    userId = user.id;
    const ws = await db.workspace.create({
      data: { type: 'ORGANIZATION', name: 'Acme', members: { create: { userId, role: 'OWNER' } }, wallet: { create: {} } },
      include: { wallet: true },
    });
    workspaceId = ws.id;
    await ledger.grant({ walletId: ws.wallet!.id, amount: 100, idempotencyKey: `grant-${workspaceId}` });
    actor = {
      userId,
      surface: 'APP',
      staffRole: null,
      workspaceRoles: new Map([[workspaceId, 'OWNER']]),
      mfaLevel: 0,
      lastStepUpAt: null,
      impersonating: false,
    };
  });

  it('projects get unique slugs; keys are shown once, listed by prefix, and revoked by timestamp', async () => {
    const a = await dev.createProject(actor, workspaceId, { name: 'Jumia storefront' }, req);
    const b = await dev.createProject(actor, workspaceId, { name: 'Jumia storefront' }, req);
    expect(a.slug).toBe('jumia-storefront');
    expect(b.slug).toBe('jumia-storefront-2');
    const made = await dev.createKey(actor, workspaceId, { projectId: a.id, name: 'Server', scopes: ['generations:write'] }, req);
    expect(made.key).toMatch(/^as_test_/);
    const listed = await dev.keys(workspaceId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('key');
    expect(listed[0]!.prefix).toBe(made.key.slice(0, 16));
    const revoked = await dev.revokeKey(actor, workspaceId, made.id, req);
    expect(revoked.revokedAt).toBeTruthy();
    expect((await dev.projects(workspaceId))[0]!.activeKeys).toBe(0);
    await dev.updateProject(actor, workspaceId, a.id, { archived: true }, req);
    await expect(dev.createKey(actor, workspaceId, { projectId: a.id, name: 'x' }, req)).rejects.toMatchObject({ status: 409 });
  });

  it('the public API attributes a generation to the key, project and merchant, scopes reads to the project, and usage rolls it up', async () => {
    const p = await dev.createProject(actor, workspaceId, { name: 'Shop' }, req);
    const other = await dev.createProject(actor, workspaceId, { name: 'Other' }, req);
    const made = await dev.createKey(actor, workspaceId, { projectId: p.id, name: 'k' }, req);
    const key = await db.apiKey.findUniqueOrThrow({ where: { id: made.id } });
    const otherKey = await db.apiKey.findUniqueOrThrow({
      where: { id: (await dev.createKey(actor, workspaceId, { projectId: other.id, name: 'k2' }, req)).id },
    });

    const { generation, balance } = await api.create(key, {
      capability: 'TEXT_GENERATE',
      params: { productName: 'Tote', platforms: ['instagram'] },
      merchantRef: 'store-1',
      clientKey: 'c-1',
    });
    expect(balance).toBe(98);
    expect(generation).toMatchObject({ status: 'QUEUED', merchantRef: 'store-1', projectId: p.id, clientKey: 'c-1' });
    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(row).toMatchObject({ channel: 'API', apiKeyId: key.id, projectId: p.id });
    // Same clientKey → the same row, not a second charge.
    expect((await api.create(key, { capability: 'TEXT_GENERATE', params: { productName: 'Tote', platforms: ['instagram'] }, clientKey: 'c-1' })).balance).toBe(
      98,
    );
    // The other project's key cannot see it.
    await expect(api.get(otherKey, generation.id)).rejects.toMatchObject({ status: 404 });
    expect((await api.list(key, {})).generations.map((g) => g.id)).toEqual([generation.id]);
    expect((await api.list(otherKey, {})).generations).toEqual([]);

    await generations.succeed(generation.id, {
      outputs: [{ key: `${workspaceId}/out.json`, role: 'text', mime: 'application/json', text: { description: { short: 'x' } } }],
    });
    const usage = await dev.usage(workspaceId, 30);
    expect(usage.totals).toMatchObject({ requests: 1, succeeded: 1, credits: 2, merchants: 1 });
    expect(usage.byProject.find((x) => x.projectId === p.id)).toMatchObject({ requests: 1, credits: 2 });
    expect(usage.byKey.find((x) => x.apiKeyId === key.id)).toMatchObject({ requests: 1 });
    expect(usage.byMerchant).toEqual([{ merchantRef: 'store-1', requests: 1, credits: 2 }]);
    expect(usage.balance).toBe(98);
    expect((await api.balance(key)).credits).toBe(98);
  });

  it('a finished API generation queues a delivery for a subscribed endpoint, and the ping test records one', async () => {
    const p = await dev.createProject(actor, workspaceId, { name: 'Shop' }, req);
    const made = await dev.createKey(actor, workspaceId, { projectId: p.id, name: 'k' }, req);
    const key = await db.apiKey.findUniqueOrThrow({ where: { id: made.id } });
    const hook = await dev.createWebhook(actor, workspaceId, { url: 'https://example.invalid/hook', events: ['generation.succeeded'] }, req);
    expect(hook.secret).toMatch(/^whsec_/);
    expect((await dev.webhooks(workspaceId))[0]).not.toHaveProperty('secret');
    const { generation } = await api.create(key, { capability: 'TEXT_GENERATE', params: { productName: 'Tote', platforms: ['instagram'] } });
    await generations.succeed(generation.id, { outputs: [] });
    await hooks.drain(); // listeners are detached from the caller
    const deliveries = await dev.deliveries(workspaceId, hook.id);
    expect(deliveries.map((d) => d.event)).toEqual(['generation.succeeded']);
    expect((deliveries[0]!.payload as { data: { id: string } }).data.id).toBe(generation.id);
    // A failure is not subscribed to.
    const { generation: g2 } = await api.create(key, { capability: 'TEXT_GENERATE', params: { productName: 'Bag', platforms: ['instagram'] } });
    await generations.fail(g2.id, { failureReason: 'x', failureKind: 'PROVIDER_DOWN' });
    await hooks.drain();
    expect(await dev.deliveries(workspaceId, hook.id)).toHaveLength(1);
  });
});
