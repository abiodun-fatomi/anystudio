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
import { GenerationHooks } from '../modules/generation/generation.hooks';
import { GenerationEvents } from '../modules/generation/generation.events';
import { LedgerService } from '../modules/ledger/ledger.service';
import { MediaService } from '../modules/media/media.service';
import { QueueService } from '../modules/queue/queue.service';
import { ProviderRegistry } from '../modules/provider/provider.registry';
import { ProviderRouter } from '../modules/provider/provider.router';
import { GenerationRunner } from './runner';
import { AudioService } from '../modules/audio/audio.service';
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
  const generations = new GenerationService(db, ledger, media, queue, new GenerationHooks());
  const events = new GenerationEvents(db);
  process.env.APP_ENV = 'test';
  const registry = new ProviderRegistry();
  const router = new ProviderRouter(db, registry);
  const runner = new GenerationRunner(db, generations, events, media, router, queue, new Pipelines());

  let workspaceId: string;
  let userId: string;
  let walletId: string;
  const START = 800;

  beforeAll(async () => {
    await db.$connect();
    await db.creditCost.upsert({ where: { code: 'text.description' }, create: { code: 'text.description', credits: 2, label: 'Copy' }, update: {} });
    await db.creditCost.upsert({ where: { code: 'image.storefront' }, create: { code: 'image.storefront', credits: 10, label: 'Image' }, update: {} });
    // The stub serves everything, at two priorities so fallback can be exercised.
    await db.providerModel.upsert({ where: { key_capability: { key: 'stub:any', capability: 'TEXT_GENERATE' } }, create: { key: 'stub:any', capability: 'TEXT_GENERATE', priority: 10, costPerCall: 0 }, update: { enabled: true, breakerOpenedAt: null, config: {} } });
    await db.providerModel.upsert({ where: { key_capability: { key: 'stub:any', capability: 'IMAGE_EDIT' } }, create: { key: 'stub:any', capability: 'IMAGE_EDIT', priority: 10, costPerCall: 4 }, update: { enabled: true, breakerOpenedAt: null, config: {} } });
    await db.providerModel.upsert({ where: { key_capability: { key: 'stub:any', capability: 'IMAGE_TO_VIDEO' } }, create: { key: 'stub:any', capability: 'IMAGE_TO_VIDEO', priority: 10, costPerCall: 80 }, update: { enabled: true, breakerOpenedAt: null, config: {} } });
    await db.providerModel.upsert({ where: { key_capability: { key: 'stub:any', capability: 'VIDEO_STITCH' } }, create: { key: 'stub:any', capability: 'VIDEO_STITCH', priority: 10, costPerCall: 0 }, update: { enabled: true, breakerOpenedAt: null, config: {} } });
    await db.providerModel.upsert({ where: { key_capability: { key: 'stub:any', capability: 'MUSIC' } }, create: { key: 'stub:any', capability: 'MUSIC', priority: 10, costPerCall: 0 }, update: { enabled: true, breakerOpenedAt: null, config: {} } });
    await db.providerModel.upsert({ where: { key_capability: { key: 'stub:any', capability: 'VOICEOVER' } }, create: { key: 'stub:any', capability: 'VOICEOVER', priority: 10, costPerCall: 0 }, update: { enabled: true, breakerOpenedAt: null, config: {} } });
    await db.providerModel.upsert({ where: { key_capability: { key: 'stub:any', capability: 'DUB' } }, create: { key: 'stub:any', capability: 'DUB', priority: 10, costPerCall: 0 }, update: { enabled: true, breakerOpenedAt: null, config: {} } });
    await db.providerModel.upsert({ where: { key_capability: { key: 'stub:any', capability: 'LIPSYNC' } }, create: { key: 'stub:any', capability: 'LIPSYNC', priority: 10, costPerCall: 0 }, update: { enabled: true, breakerOpenedAt: null, config: {} } });
    await db.musicGenre.upsert({ where: { key: 'test-afrobeats' }, create: { key: 'test-afrobeats', name: 'Afrobeats', region: 'Nigeria', family: 'african', description: 'test', promptHints: 'log drum, shakers, warm bass', languages: ['en'] }, update: {} });
    await db.voiceProfile.upsert({ where: { key: 'test-voice' }, create: { key: 'test-voice', providerKey: 'stub:any', providerVoiceId: 'stub-v', name: 'Stub voice', language: 'en-NG', tags: [] }, update: { providerKey: 'stub:any', active: true } });
    for (const c of [{ code: 'video.ad_15s', credits: 260, label: 'Ad' }, { code: 'video.shot', credits: 0, label: 'Shot' }, { code: 'audio.music.preview', credits: 10, label: 'Song preview' }, { code: 'audio.music.unlock', credits: 30, label: 'Unlock' }, { code: 'audio.voiceover', credits: 8, label: 'Voiceover' }, { code: 'video.translate', credits: 90, label: 'Translate' }, { code: 'video.translate_lipsync', credits: 240, label: 'Translate with lips' }, { code: 'video.lipsync', credits: 150, label: 'Lip-sync' }]) {
      await db.creditCost.upsert({ where: { code: c.code }, create: c, update: {} });
    }
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
    await db.mediaAsset.create({ data: { workspaceId, kind: 'SOURCE', status: 'READY', key: `${workspaceId}/2026/09/uploads/clip.mp4`, mime: 'video/mp4' } });
  });

  it('a dub with lips: priced as such, dubbed by one vendor, lips finished by a LIPSYNC vendor when the first left them alone', async () => {
    const sourceKey = `${workspaceId}/2026/09/uploads/clip.mp4`;
    await expect(generations.request({ workspaceId, requestedById: userId, capability: 'DUB', clientKey: 'dub-0', params: { sourceKey, targetLanguage: 'en-NG', lipsync: true } })).rejects.toMatchObject({ details: { consent: expect.stringContaining('permission') } });
    const { generation } = await generations.request({ workspaceId, requestedById: userId, capability: 'DUB', clientKey: 'dub-1', params: { sourceKey, targetLanguage: 'en-NG', lipsync: true, consent: true } });
    expect(generation.costCode).toBe('video.translate_lipsync');
    expect(generation.credits).toBe(240);
    expect(generation.title).toBe('Dubbed into English (Nigeria)');
    expect(await runner.run(generation.id)).toBe('succeeded');
    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    const outputs = row.outputs as Array<{ role: string; key: string; text?: { lipsync?: boolean; language?: string; dubbedBy?: string } }>;
    expect(outputs.filter((o) => o.role === 'video')).toHaveLength(1);
    expect(outputs.find((o) => o.role === 'text')?.text).toMatchObject({ lipsync: true, language: 'English (Nigeria)', dubbedBy: 'stub:any' });
    expect(row.providerKey).toBe('stub:any+stub:any');
    // The dubbed intermediate and its soundtrack were stored for the lip-sync vendor, outside the outputs.
    expect([...media.objects.keys()].some((k) => k.includes(`gen/${generation.id}/work/dubbed.mp3`))).toBe(true);
    expect(await ledger.balance(walletId)).toBe(START - 240);

    // Voice only: cheaper, no second vendor.
    const quiet = await generations.request({ workspaceId, requestedById: userId, capability: 'DUB', clientKey: 'dub-2', params: { sourceKey, targetLanguage: 'fr', consent: true } });
    expect(quiet.generation.credits).toBe(90);
    expect(await runner.run(quiet.generation.id)).toBe('succeeded');
    const quietRow = await db.generation.findUniqueOrThrow({ where: { id: quiet.generation.id } });
    expect(quietRow.providerKey).toBe('stub:any');
    expect((quietRow.outputs as Array<{ role: string; text?: { lipsync?: boolean } }>).find((o) => o.role === 'text')?.text?.lipsync).toBe(false);

    // A language nobody dubs into fails before any vendor is asked, credits back.
    const nope = await generations.request({ workspaceId, requestedById: userId, capability: 'DUB', clientKey: 'dub-3', params: { sourceKey, targetLanguage: 'yo', consent: true } });
    expect(await runner.run(nope.generation.id)).toBe('failed');
    expect(await ledger.balance(walletId)).toBe(START - 240 - 90);
  }, 60_000);

  it('a lip-sync from a script records the voice first, then syncs, and keeps the words on the row', async () => {
    const sourceKey = `${workspaceId}/2026/09/uploads/clip.mp4`;
    await expect(generations.request({ workspaceId, requestedById: userId, capability: 'LIPSYNC', clientKey: 'ls-0', params: { sourceKey, consent: true } })).rejects.toMatchObject({ details: { script: expect.stringContaining('audio file or write a script') } });
    const { generation } = await generations.request({ workspaceId, requestedById: userId, capability: 'LIPSYNC', clientKey: 'ls-1', params: { sourceKey, script: 'New stock **today**.', voiceId: 'test-voice', consent: true } });
    expect(generation.credits).toBe(150);
    expect(await runner.run(generation.id)).toBe('succeeded');
    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    const outputs = row.outputs as Array<{ role: string; text?: { script?: string; voice?: string } }>;
    expect(outputs.find((o) => o.role === 'video')).toBeTruthy();
    expect(outputs.find((o) => o.role === 'text')?.text).toMatchObject({ script: 'New stock today.', voice: 'test-voice' });
    expect(row.providerKey).toBe('stub:any+stub:any');
    expect([...media.objects.keys()].some((k) => k.includes(`gen/${generation.id}/work/voice.mp3`))).toBe(true);
    expect(await ledger.balance(walletId)).toBe(START - 150);
  }, 60_000);

  it('a song: lyrics are written, the full track is vaulted and locked, the preview is open, unlocking pays once and copies it out', async () => {
    const { generation } = await generations.request({ workspaceId, requestedById: userId, capability: 'MUSIC', clientKey: 'song-1', params: { brief: 'a song about my ankara bags', genre: 'test-afrobeats', vocal: 'female', durationSec: 60 } });
    expect(generation.credits).toBe(10);
    expect(await runner.run(generation.id)).toBe('succeeded');
    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    const outputs = row.outputs as Array<{ role: string; key: string; locked?: boolean; text?: { lyrics?: string } }>;
    const full = outputs.find((o) => o.role === 'audio')!;
    expect(full.locked).toBe(true);
    expect(full.key).toContain('/vault/');
    expect(media.objects.has(full.key)).toBe(true);
    const preview = outputs.find((o) => o.role === 'preview')!;
    expect(preview.key).not.toContain('/vault/');
    expect(outputs.find((o) => o.role === 'text')?.text?.lyrics).toContain('[Chorus]');
    expect((row.input as { lyricsWritten?: string }).lyricsWritten).toContain('[Verse]');
    // The customer view never carries the vault key.
    const view = await generations.get(workspaceId, generation.id);
    expect((view.generation.outputs as Array<{ role: string; key: string }>).find((o) => o.role === 'audio')?.key).toBe('');
    expect(await ledger.balance(walletId)).toBe(START - 10);

    const audio = new AudioService(db, ledger, Object.assign(media, { copy: async (from: string, to: string) => { media.objects.set(to, media.objects.get(from)!); } }));
    const actor = { userId, surface: 'APP' as const, staffRole: null, workspaceRoles: new Map([[workspaceId, 'OWNER' as const]]), mfaLevel: 0, lastStepUpAt: null, impersonating: false };
    const req = { ip: '127.0.0.1', requestId: 'r', get: () => 'test' } as never;
    const first = await audio.unlock(actor, workspaceId, generation.id, req);
    expect(first.status).toBe('unlocked');
    expect(await ledger.balance(walletId)).toBe(START - 40);
    const again = await audio.unlock(actor, workspaceId, generation.id, req);
    expect(again.status).toBe('already_unlocked');
    expect(await ledger.balance(walletId)).toBe(START - 40);
    const after = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    const opened = (after.outputs as Array<{ role: string; key: string; locked?: boolean }>).find((o) => o.role === 'audio')!;
    expect(opened.locked).toBe(false);
    expect(opened.key).not.toContain('/vault/');
    expect(media.objects.has(opened.key)).toBe(true);
  });

  it('a voiceover routes to the voice\'s own vendor and records the script alongside the audio', async () => {
    const { generation } = await generations.request({ workspaceId, requestedById: userId, capability: 'VOICEOVER', clientKey: 'vo-1', params: { script: 'Fresh ankara bags, **now** in stock.', voiceId: 'test-voice' } });
    expect(await runner.run(generation.id)).toBe('succeeded');
    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    const outputs = row.outputs as Array<{ role: string; text?: { script?: string; words?: number } }>;
    expect(outputs.find((o) => o.role === 'audio')).toBeTruthy();
    expect(outputs.find((o) => o.role === 'text')?.text?.script).toBe('Fresh ankara bags, now in stock.');
    expect(await ledger.balance(walletId)).toBe(START - 8);
    await expect(generations.request({ workspaceId, requestedById: userId, capability: 'VOICEOVER', clientKey: 'vo-2', params: { script: 'x', voiceId: 'no-such-voice' } }).then((r) => runner.run(r.generation.id))).resolves.toBe('failed');
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

  it('runs a two-shot ad: parent plans and steps aside, shots run, the last one wakes it, it assembles', async () => {
    const { generation: parent } = await generations.request({ workspaceId, requestedById: userId, capability: 'IMAGE_TO_VIDEO', clientKey: 'ad-1', params: { sourceKey: `${workspaceId}/2026/09/uploads/src.png`, prompt: 'show the bag', shots: 2, format: 'reveal', productName: 'Ankara tote', price: '₦12,000' } });
    expect(parent.kind).toBe('PARENT');
    expect(parent.costCode).toBe('video.ad_15s');
    expect(await ledger.balance(walletId)).toBe(START - 260);

    // First run: the plan is written and two children exist; the parent is RUNNING at 'waiting'.
    expect(await runner.run(parent.id)).toBe('waiting');
    const children = await db.generation.findMany({ where: { parentId: parent.id }, orderBy: { createdAt: 'asc' } });
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.kind === 'CHILD' && c.credits === 0 && c.status === 'QUEUED')).toBe(true);
    expect((await db.generation.findUniqueOrThrow({ where: { id: parent.id } })).stage).toBe('waiting');

    // The shots render (stub video needs ffmpeg; present in CI and the worker image).
    expect(await runner.run(children[0]!.id)).toBe('succeeded');
    expect((await db.generation.findUniqueOrThrow({ where: { id: parent.id } })).stage).toBe('waiting'); // one to go
    expect(await runner.run(children[1]!.id)).toBe('succeeded');

    // No Redis in tests, so the wake-up enqueue did nothing; the dispatcher's sweep finds it.
    expect(await generations.wakeReadyParents()).toContain(parent.id);
    expect(await runner.run(parent.id)).toBe('succeeded');

    const done = await db.generation.findUniqueOrThrow({ where: { id: parent.id } });
    const outputs = done.outputs as Array<{ role: string; key: string }>;
    expect(outputs.some((o) => o.role === 'video')).toBe(true);
    expect(done.providerCostMinor).toBe(160); // two shots at the row's 80, stitching free
    expect(await ledger.balance(walletId)).toBe(START - 260);
    // Children are hidden from the customer's history; the parent is one row.
    expect((await generations.history(workspaceId)).map((g) => g.id)).toContain(parent.id);
    expect((await generations.history(workspaceId)).map((g) => g.id)).not.toContain(children[0]!.id);
  }, 60_000);

  it('refunds the whole ad when a shot fails for good', async () => {
    const { generation: parent } = await generations.request({ workspaceId, requestedById: userId, capability: 'IMAGE_TO_VIDEO', clientKey: 'ad-2', params: { sourceKey: `${workspaceId}/2026/09/uploads/src.png`, prompt: 'show the bag', shots: 2 } });
    expect(await runner.run(parent.id)).toBe('waiting');
    const children = await db.generation.findMany({ where: { parentId: parent.id } });
    await db.providerModel.update({ where: { key_capability: { key: 'stub:any', capability: 'IMAGE_TO_VIDEO' } }, data: { config: { behaviour: 'fail:CONTENT_REJECTED' } } });
    try {
      for (const c of children) expect(await runner.run(c.id)).toBe('failed');
    } finally {
      await db.providerModel.update({ where: { key_capability: { key: 'stub:any', capability: 'IMAGE_TO_VIDEO' } }, data: { config: {} } });
    }
    await generations.wakeReadyParents();
    expect(await runner.run(parent.id)).toBe('failed');
    const done = await db.generation.findUniqueOrThrow({ where: { id: parent.id } });
    expect(done.failureKind).toBe('CONTENT_REJECTED');
    expect(await ledger.balance(walletId)).toBe(START); // the whole price, not three quarters of it
  }, 60_000);

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
