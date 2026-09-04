/**
 * The whole pipeline against a real Postgres, a stub provider and in-memory
 * storage: request → run → outputs stored → credits stand; and every way it
 * can fail → credits back, with the customer told why in plain words.
 *
 * Skipped without DATABASE_URL, like the other integration suites; CI sets it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type MediaAsset, type MediaKind } from '@prisma/client';
import { GenerationService } from '../modules/generation/generation.service';
import { GenerationEvents } from '../modules/generation/generation.events';
import { LedgerService } from '../modules/ledger/ledger.service';
import { MediaService } from '../modules/media/media.service';
import { QueueService } from '../modules/queue/queue.service';
import { ProviderRegistry } from '../modules/provider/provider.registry';
import { ProviderRouter } from '../modules/provider/provider.router';
import { GenerationRunner } from './runner';
import { Pipelines } from './pipelines';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

/** Storage in a Map: the runner only needs put/get/sign/record. */
class MemoryMedia extends MediaService {
  readonly objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  constructor(db: PrismaClient) { super(db); }
  override async put(key: string, bytes: Uint8Array | Buffer, mime: string): Promise<void> { this.objects.set(key, { bytes: new Uint8Array(bytes), mime }); }
  override async getBytes(key: string): Promise<Buffer> { return Buffer.from(this.objects.get(key)!.bytes); }
  override async signRead(key: string): Promise<string> { return `memory://${key}`; }
  override async requireReady(_workspaceId: string, key: string): Promise<MediaAsset> { return { key } as MediaAsset; }
  override async recordOutput(input: { workspaceId: string; generationId: string; key: string; kind: MediaKind; mime: string; bytes: number }): Promise<MediaAsset> {
    return super.recordOutput(input);
  }
}

suite('GenerationRunner', () => {
  const db = new PrismaClient();
  const ledger = new LedgerService(db);
  const media = new MemoryMedia(db);
  const queue = new QueueService();
  const generations = new GenerationService(db, ledger, media, queue);
  const events = new GenerationEvents(db);
  process.env.APP_ENV = 'test';
  const registry = new ProviderRegistry();
  const router = new ProviderRouter(db, registry);
  const runner = new GenerationRunner(db, generations, events, media, router, queue, new Pipelines());

  let workspaceId: string;
  let userId: string;
  let walletId: string;
  const START = 500;

  beforeAll(async () => {
    await db.$connect();
    await db.creditCost.upsert({ where: { code: 'text.description' }, create: { code: 'text.description', credits: 2, label: 'Copy' }, update: {} });
    await db.creditCost.upsert({ where: { code: 'image.storefront' }, create: { code: 'image.storefront', credits: 10, label: 'Image' }, update: {} });
    // The stub serves everything, at two priorities so fallback can be exercised.
    await db.providerModel.upsert({ where: { key_capability: { key: 'stub:any', capability: 'TEXT_GENERATE' } }, create: { key: 'stub:any', capability: 'TEXT_GENERATE', priority: 10, costPerCall: 0 }, update: { enabled: true, breakerOpenedAt: null, config: {} } });
    await db.providerModel.upsert({ where: { key_capability: { key: 'stub:any', capability: 'IMAGE_EDIT' } }, create: { key: 'stub:any', capability: 'IMAGE_EDIT', priority: 10, costPerCall: 4 }, update: { enabled: true, breakerOpenedAt: null, config: {} } });
  });
  afterAll(async () => { await events.onModuleDestroy(); await db.$disconnect(); });

  /** Make the stub misbehave for one test, through the row — the only door the worker reads. */
  const misbehave = (behaviour: string) =>
    db.providerModel.update({ where: { key_capability: { key: 'stub:any', capability: 'TEXT_GENERATE' } }, data: { config: { behaviour } } });
  afterEach(async () => { await misbehave('ok'); });

  beforeEach(async () => {
    const user = await db.user.create({ data: { email: `run-${crypto.randomUUID()}@test.local`, status: 'ACTIVE' } });
    const workspace = await db.workspace.create({ data: { type: 'BUSINESS', name: 'Runner test', profile: { sells: 'ankara bags' } } });
    const wallet = await db.wallet.create({ data: { workspaceId: workspace.id } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' } });
    await ledger.grant({ walletId: wallet.id, amount: START, idempotencyKey: `seed:${wallet.id}`, reason: 'fixture' });
    userId = user.id; workspaceId = workspace.id; walletId = wallet.id;
    await db.mediaAsset.create({ data: { workspaceId, kind: 'SOURCE', status: 'READY', key: `${workspaceId}/2026/09/uploads/src.png`, mime: 'image/png' } });
  });

  it('runs a copy generation end to end: outputs on the row, credits stand, stage narrated', async () => {
    const { generation } = await generations.request({ workspaceId, requestedById: userId, capability: 'TEXT_GENERATE', clientKey: 'copy-1', params: { productName: 'Ankara tote', price: '₦12,000', platforms: ['instagram', 'whatsapp_status'] } });
    expect(await runner.run(generation.id)).toBe('succeeded');

    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(row.status).toBe('SUCCEEDED');
    expect(row.stage).toBe('done');
    expect(row.providerKey).toBe('stub:any');
    const outputs = row.outputs as Array<{ role: string; text?: { captions?: Record<string, string> } }>;
    expect(outputs[0]?.role).toBe('text');
    expect(outputs[0]?.text?.captions?.instagram).toContain('Ankara tote');
    expect(await ledger.balance(walletId)).toBe(START - 2);
  });

  it('runs a branded image: composite, size variants and thumbnails land in storage and the library', async () => {
    const { generation } = await generations.request({ workspaceId, requestedById: userId, capability: 'IMAGE_EDIT', clientKey: 'img-1', params: { sourceKey: `${workspaceId}/2026/09/uploads/src.png`, prompt: 'on a marble counter', price: '₦12,000', businessName: 'Bimbo Fabrics', sizes: ['feed_square', 'story'] } });
    expect(await runner.run(generation.id)).toBe('succeeded');

    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    const outputs = row.outputs as Array<{ role: string; key: string; size?: string; width?: number; height?: number }>;
    expect(outputs.filter((o) => o.role === 'image')).toHaveLength(1);
    expect(outputs.filter((o) => o.role === 'variant').map((o) => [o.size, o.width, o.height])).toEqual([['feed_square', 1080, 1080], ['story', 1080, 1920]]);
    expect(outputs.filter((o) => o.role === 'thumb').length).toBeGreaterThan(0);
    for (const o of outputs) expect(media.objects.has(o.key)).toBe(true);
    expect(await db.mediaAsset.count({ where: { generationId: generation.id, kind: 'OUTPUT' } })).toBe(3);
    expect(row.providerCostMinor).toBe(4);
    expect(await ledger.balance(walletId)).toBe(START - 10);
  });

  it('refunds at once on CONTENT_REJECTED and tells the customer in plain words', async () => {
    await misbehave('fail:CONTENT_REJECTED');
    const { generation } = await generations.request({ workspaceId, requestedById: userId, capability: 'TEXT_GENERATE', clientKey: 'rej-1', params: { productName: 'x' } });
    expect(await runner.run(generation.id)).toBe('failed');

    const view = await generations.get(workspaceId, generation.id);
    expect(view.generation.status).toBe('FAILED');
    expect(view.generation.failureKind).toBe('CONTENT_REJECTED');
    expect(view.message).toMatch(/could not be used/);
    expect(await ledger.balance(walletId)).toBe(START);
  });

  it('requeues a RETRYABLE failure while attempts remain, then fails and refunds', async () => {
    await misbehave('fail:RETRYABLE');
    const { generation } = await generations.request({ workspaceId, requestedById: userId, capability: 'TEXT_GENERATE', clientKey: 'retry-1', params: { productName: 'x' } });
    expect(await runner.run(generation.id)).toBe('requeued');
    expect((await db.generation.findUniqueOrThrow({ where: { id: generation.id } })).status).toBe('QUEUED');
    expect(await runner.run(generation.id)).toBe('requeued');
    expect(await runner.run(generation.id)).toBe('failed');

    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(row.attempts).toBe(3);
    expect(row.status).toBe('FAILED');
    expect(await ledger.balance(walletId)).toBe(START);
  });

  it('drops a job for a row that is no longer QUEUED', async () => {
    const { generation } = await generations.request({ workspaceId, requestedById: userId, capability: 'TEXT_GENERATE', clientKey: 'dup-1', params: { productName: 'x' } });
    await generations.cancel(generation.id);
    expect(await runner.run(generation.id)).toBe('skipped');
    expect(await ledger.balance(walletId)).toBe(START);
  });

  it('streams the truth from the row when there is no Redis', async () => {
    const { generation } = await generations.request({ workspaceId, requestedById: userId, capability: 'TEXT_GENERATE', clientKey: 'evt-1', params: { productName: 'x' } });
    const seen: string[] = [];
    const abort = new AbortController();
    const watching = (async () => { for await (const e of events.watch(generation.id, abort.signal)) seen.push(e.type === 'stage' ? e.stage : e.type); })();
    await runner.run(generation.id);
    await watching;
    expect(seen[0]).toBe('queued');
    expect(seen.at(-1)).toBe('done');
  }, 20_000);
});
