/**
 * Integration tests, against a real Postgres.
 *
 * Deliberately not unit tests with a mocked Prisma. Everything worth testing
 * here is database behaviour — a transaction that must roll back as a unit, an
 * idempotency key enforced inside a row lock, a status guard that stops a
 * second refund. Mock the database and you assert that the mock was called,
 * which is exactly the class of test that passes while money leaks.
 *
 * Skipped when DATABASE_URL is unset, so a fresh checkout still runs the suite.
 * CI always sets it (a Postgres service container with the migrations applied),
 * so these run on every pull request.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { GenerationService } from './generation.service';
import { GenerationHooks } from './generation.hooks';
import { LedgerService } from '../ledger/ledger.service';
import { MediaService } from '../media/media.service';
import { QueueService } from '../queue/queue.service';
import { AppError } from '../../../config/globals/errors';
import type { GenerationRequest } from './generation.types';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('GenerationService', () => {
  const db = new PrismaClient();
  const ledger = new LedgerService(db);
  const media = new MediaService(db);
  // No REDIS_URL in tests: the queue is a no-op and the row is the only truth — exactly the degraded mode.
  const service = new GenerationService(db, ledger, media, new QueueService(), new GenerationHooks());

  let workspaceId: string;
  let userId: string;
  let walletId: string;

  const COST = 'text.description';
  const PRICE = 2;
  const STARTING_CREDITS = 100;

  beforeAll(async () => {
    await db.$connect();
    await Promise.all([
      db.creditCost.upsert({
        where: { code: COST },
        create: { code: COST, credits: PRICE, label: 'Test image' },
        update: {},
      }),
      db.creditCost.upsert({
        where: { code: 'audio.music.preview' },
        create: { code: 'audio.music.preview', credits: 10, label: 'Song generation' },
        update: { credits: 10 },
      }),
      db.creditCost.upsert({
        where: { code: 'audio.music.preview.my_voice' },
        create: { code: 'audio.music.preview.my_voice', credits: 20, label: 'Song in your voice' },
        update: { credits: 20 },
      }),
    ]);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  /** A fresh workspace, user and funded wallet for every test, so none can see another's rows. */
  beforeEach(async () => {
    const user = await db.user.create({ data: { email: `gen-${crypto.randomUUID()}@test.local`, status: 'ACTIVE' } });
    const workspace = await db.workspace.create({ data: { type: 'PERSONAL', name: 'Test' } });
    const wallet = await db.wallet.create({ data: { workspaceId: workspace.id } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' } });
    await ledger.grant({
      walletId: wallet.id,
      amount: STARTING_CREDITS,
      idempotencyKey: `seed:${wallet.id}`,
      reason: 'test fixture',
    });
    userId = user.id;
    workspaceId = workspace.id;
    walletId = wallet.id;
  });

  const request = (clientKey: string = crypto.randomUUID()) =>
    service.request({ workspaceId, requestedById: userId, capability: 'TEXT_GENERATE', clientKey, params: { productName: 'Ankara tote' } });

  it('debits the credits when the generation is requested, not when it succeeds', async () => {
    const { generation, balance } = await request();

    expect(generation.status).toBe('QUEUED');
    expect(generation.credits).toBe(PRICE);
    expect(balance).toBe(STARTING_CREDITS - PRICE);
  });

  it('copies the server-owned price onto the generation row', async () => {
    const price = await db.creditCost.findUniqueOrThrow({ where: { code: COST } });
    const { generation } = await request();

    const reread = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(reread.credits).toBe(price.credits);
  });

  it('cannot underprice a normal request by injecting the zero-credit child code', async () => {
    await db.creditCost.upsert({
      where: { code: 'video.shot' },
      create: { code: 'video.shot', credits: 0, label: 'Internal child shot' },
      update: { credits: 0 },
    });
    const malicious: GenerationRequest & { costCode: string } = {
      workspaceId,
      requestedById: userId,
      capability: 'TEXT_GENERATE',
      clientKey: crypto.randomUUID(),
      params: { productName: 'Ankara tote' },
      costCode: 'video.shot',
    };

    const { generation, balance } = await service.request(malicious);

    expect(generation.costCode).toBe(COST);
    expect(generation.credits).toBe(PRICE);
    expect(balance).toBe(STARTING_CREDITS - PRICE);
  });

  it('writes no row at all when the wallet cannot afford it', async () => {
    await ledger.expire({
      walletId,
      amount: STARTING_CREDITS - (PRICE - 1),
      idempotencyKey: `drain:${walletId}`,
      reason: 'leave less than one generation costs',
    });

    await expect(request()).rejects.toMatchObject({ code: 'insufficient_credits', status: 402 });
    expect(await db.generation.count({ where: { workspaceId } })).toBe(0);
    expect(await ledger.balance(walletId)).toBe(PRICE - 1);
  });

  it('refunds when the generation fails', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    const failed = await service.fail(generation.id, { failureReason: 'provider timed out' });

    expect(failed.status).toBe('FAILED');
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);
  });

  it('reconciles durable provider-attempt spend when a sweeper fails a generation', async () => {
    const { generation } = await request();
    const running = await service.start(generation.id);
    await db.providerAttempt.create({
      data: {
        generationId: generation.id,
        operationKey: 'text-plan:0',
        providerKey: 'paid:text',
        capability: 'TEXT_GENERATE',
        generationAttempt: running!.attempts,
        status: 'SUCCEEDED',
        costMinor: 17,
        finishedAt: new Date(),
      },
    });

    const failed = await service.fail(generation.id, { failureReason: 'worker disappeared' });

    expect(failed.providerCostMinor).toBe(17);
  });

  it('refunds exactly once, however many times a failure is replayed', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    await service.fail(generation.id, { failureReason: 'first' });

    await expect(service.fail(generation.id, { failureReason: 'second' })).rejects.toBeInstanceOf(AppError);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);
  });

  it('keeps the credits when the generation succeeds', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    const done = await service.succeed(generation.id, { outputs: [{ key: 'out.webp', role: 'image', mime: 'image/webp' }], providerJobId: 'p-1' });

    expect(done.status).toBe('SUCCEEDED');
    expect(done.providerJobId).toBe('p-1');
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS - PRICE);
  });

  it('atomically refunds the personal-voice premium when a successful song kept the model singer', async () => {
    const voiceKey = `mine:${crypto.randomUUID()}`;
    await db.voiceProfile.create({
      data: {
        key: voiceKey,
        providerKey: 'elevenlabs:tts',
        providerVoiceId: 'voice-1',
        name: 'Mine',
        language: 'en',
        tags: [],
        kind: 'CLONE',
        workspaceId,
        consentAt: new Date(),
        createdById: userId,
      },
    });
    const { generation } = await service.request({
      workspaceId,
      requestedById: userId,
      capability: 'MUSIC',
      clientKey: crypto.randomUUID(),
      params: { brief: 'A song for the shop', genre: 'afrobeats', vocal: 'female', singer: 'me', voiceId: voiceKey, durationSec: 30 },
    });
    expect(generation.credits).toBe(20);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS - 20);

    await service.start(generation.id);
    const done = await service.succeed(generation.id, {
      outputs: [{ key: 'result.json', role: 'text', mime: 'application/json', text: { myVoice: { applied: false } } }],
    });

    expect(done.status).toBe('SUCCEEDED');
    expect(done.credits).toBe(10);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS - 10);
    expect(await db.ledgerEntry.count({ where: { referenceId: generation.id, kind: 'REFUND' } })).toBe(1);
  });

  it('rejects an unowned personal voice before reserving credits or creating a generation', async () => {
    await expect(
      service.request({
        workspaceId,
        requestedById: userId,
        capability: 'MUSIC',
        clientKey: crypto.randomUUID(),
        params: { brief: 'A song for the shop', genre: 'afrobeats', vocal: 'female', singer: 'me', voiceId: 'mine:not-ours', durationSec: 30 },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await db.generation.count({ where: { workspaceId } })).toBe(0);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);
  });

  it('will not un-refund a failed generation if the provider answers late', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    await service.fail(generation.id, { failureReason: 'timed out' });

    await expect(service.succeed(generation.id, { outputs: [] })).rejects.toBeInstanceOf(AppError);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);
  });

  it('lets exactly one concurrent success, failure or cancellation become terminal', async () => {
    const { generation } = await request();
    const results = await Promise.allSettled([
      service.succeed(generation.id, { outputs: [{ key: 'winner.webp', role: 'image', mime: 'image/webp' }] }),
      service.fail(generation.id, { failureReason: 'racing failure' }),
      service.cancel(generation.id),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(['SUCCEEDED', 'FAILED', 'CANCELLED']).toContain(row.status);
    const refunded = row.status === 'FAILED' || row.status === 'CANCELLED';
    expect(await ledger.balance(walletId)).toBe(refunded ? STARTING_CREDITS : STARTING_CREDITS - PRICE);
    expect(await db.ledgerEntry.count({ where: { referenceId: generation.id, kind: 'REFUND' } })).toBe(refunded ? 1 : 0);
  });

  it('rolls back the terminal claim when its refund cannot commit', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    const refusingLedger = new LedgerService(db);
    refusingLedger.refund = async () => {
      throw new Error('ledger unavailable');
    };
    const refusingService = new GenerationService(db, refusingLedger, new MediaService(db), new QueueService(), new GenerationHooks());

    await expect(refusingService.fail(generation.id, { failureReason: 'provider failed' })).rejects.toThrow('ledger unavailable');

    expect((await db.generation.findUniqueOrThrow({ where: { id: generation.id } })).status).toBe('RUNNING');
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS - PRICE);
  });

  it('lets only one worker start a generation', async () => {
    const { generation } = await request();

    const first = await service.start(generation.id, 'higgsfield:test');
    const second = await service.start(generation.id, 'heygen:test');

    expect(first?.status).toBe('RUNNING');
    expect(second).toBeNull();
    expect(first?.attempts).toBe(1);
  });

  it('cancels and refunds while queued, and refuses once running', async () => {
    const a = await request();
    const cancelled = await service.cancel(a.generation.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);

    const b = await request();
    await service.start(b.generation.id);
    await expect(service.cancel(b.generation.id)).rejects.toMatchObject({ status: 409 });
  });

  it.each(['succeed', 'fail', 'cancel'] as const)('retires and purges generation work on %s', async (transition) => {
    const { generation } = await request();
    if (transition !== 'cancel') await service.start(generation.id);
    const key = `${MediaService.generationWorkPrefix(workspaceId, generation.id, generation.createdAt)}scratch.mp3`;
    await db.mediaAsset.create({
      data: { workspaceId, generationId: generation.id, kind: 'DERIVED', status: 'READY', key, mime: 'audio/mpeg', bytes: 3 },
    });
    const remove = vi.spyOn(media, 'deleteObject').mockResolvedValue(true);
    try {
      if (transition === 'succeed') await service.succeed(generation.id, { outputs: [] });
      else if (transition === 'fail') await service.fail(generation.id, { failureReason: 'test' });
      else await service.cancel(generation.id);

      expect(remove).toHaveBeenCalledWith(key);
      expect(await db.mediaAsset.findUniqueOrThrow({ where: { key } })).toMatchObject({ status: 'PURGED', deletedAt: expect.any(Date) });
    } finally {
      remove.mockRestore();
    }
  });

  it('keeps parent work while it is waiting for children, then removes it when the parent becomes terminal', async () => {
    const parent = await db.generation.create({
      data: {
        workspaceId,
        requestedById: userId,
        capability: 'IMAGE_TO_VIDEO',
        kind: 'PARENT',
        costCode: 'video.reel',
        credits: 0,
        status: 'RUNNING',
        input: { sourceKey: `${workspaceId}/source.jpg`, shots: 1 },
      },
    });
    const key = `${MediaService.generationWorkPrefix(workspaceId, parent.id, parent.createdAt)}presenter.mp4`;
    await db.mediaAsset.create({ data: { workspaceId, generationId: parent.id, kind: 'DERIVED', status: 'READY', key, mime: 'video/mp4', bytes: 3 } });
    const remove = vi.spyOn(media, 'deleteObject').mockResolvedValue(true);
    try {
      await service.wait(parent.id);
      expect(remove).not.toHaveBeenCalled();
      expect(await db.mediaAsset.findUniqueOrThrow({ where: { key } })).toMatchObject({ status: 'READY', deletedAt: null });

      await service.fail(parent.id, { failureReason: 'test cleanup after waiting' });
      expect(remove).toHaveBeenCalledWith(key);
    } finally {
      remove.mockRestore();
    }
  });

  it('requeues a generation whose worker went silent, and refunds only when attempts are spent', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    // Backdate the heartbeat rather than waiting fifteen minutes.
    const silent = () => db.generation.update({ where: { id: generation.id }, data: { heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await silent();

    // First interruption: another attempt, the debit stands.
    expect(await service.sweepStale()).toContain(generation.id);
    let row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(row.status).toBe('QUEUED');
    expect(row.failureReason).toMatch(/stopped mid-job/);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS - row.credits);

    // Attempts spent: failed and refunded.
    await db.generation.update({ where: { id: generation.id }, data: { attempts: 3 } });
    await service.start(generation.id);
    await silent();
    expect(await service.sweepStale()).toContain(generation.id);
    row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(row.status).toBe('FAILED');
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);
  });

  it('retries a crashed parent assembly on media.local and counts the new attempt', async () => {
    const heartbeatAt = new Date(Date.now() - 60 * 60 * 1000);
    const plan = {
      hook: 'Watch this',
      shots: [{ prompt: 'A detailed product shot on a clean table', motion: 'slow push-in', durationSec: 5, caption: 'Made for you' }],
      endCard: { text: 'Order now' },
    };
    const parent = await db.generation.create({
      data: {
        workspaceId,
        requestedById: userId,
        capability: 'IMAGE_TO_VIDEO',
        kind: 'PARENT',
        costCode: 'video.reel',
        credits: 0,
        status: 'RUNNING',
        attempts: 2,
        stage: 'composing',
        heartbeatAt,
        input: { sourceKey: `${workspaceId}/source.jpg`, shots: 1, plan },
      },
    });
    await db.generation.create({
      data: {
        workspaceId,
        requestedById: userId,
        capability: 'IMAGE_TO_VIDEO',
        kind: 'CHILD',
        parentId: parent.id,
        clientKey: `${parent.id}:shot:0`,
        costCode: 'video.shot',
        credits: 0,
        status: 'SUCCEEDED',
        input: { sourceKey: `${workspaceId}/source.jpg` },
        outputs: [{ key: `${workspaceId}/shot.mp4`, role: 'video', mime: 'video/mp4' }],
      },
    });

    expect(await service.sweepStale()).toContain(parent.id);
    const waiting = await db.generation.findUniqueOrThrow({ where: { id: parent.id } });
    expect(waiting.status).toBe('RUNNING');
    expect(waiting.stage).toBe('waiting');
    expect(waiting.attempts).toBe(2);

    const resumed = await service.resume(parent.id);
    expect(resumed?.stage).toBe('composing');
    expect(resumed?.attempts).toBe(3);
  });

  it('does not reclaim a row that is merely waiting in a busy queue', async () => {
    const { generation } = await request();
    await db.generation.update({ where: { id: generation.id }, data: { createdAt: new Date(Date.now() - 30 * 60 * 1000) } });
    expect(await service.sweepStale()).not.toContain(generation.id);
    await db.generation.update({ where: { id: generation.id }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    expect(await service.sweepStale()).toContain(generation.id);
    expect((await db.generation.findUniqueOrThrow({ where: { id: generation.id } })).failureReason).toMatch(/no worker picked it up/);
  });

  it('leaves a generation alone while its worker is still checking in', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    await service.heartbeat(generation.id);

    expect(await service.sweepStale()).not.toContain(generation.id);
    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(row.status).toBe('RUNNING');
  });

  it('returns the same row for the same clientKey, and charges once', async () => {
    const a = await request('tap-tap');
    const b = await request('tap-tap');

    expect(b.generation.id).toBe(a.generation.id);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS - PRICE);
  });

  it('reuses a child shot when a restarted parent dispatches the same index again', async () => {
    const parent = await db.generation.create({
      data: {
        workspaceId,
        requestedById: userId,
        capability: 'IMAGE_TO_VIDEO',
        kind: 'PARENT',
        clientKey: crypto.randomUUID(),
        costCode: 'video.ad_15s',
        credits: 0,
        input: { sourceKey: `${workspaceId}/source.jpg`, shots: 2 },
      },
    });
    const first = await service.createChild(parent, 'IMAGE_TO_VIDEO', { sourceKey: `${workspaceId}/source.jpg`, prompt: 'first' }, 0);
    await db.generation.update({ where: { id: first.id }, data: { status: 'SUCCEEDED', outputs: [] } });

    const replay = await service.createChild(parent, 'IMAGE_TO_VIDEO', { sourceKey: `${workspaceId}/source.jpg`, prompt: 'different retry input' }, 0);

    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe('SUCCEEDED');
    expect(replay.input).toEqual({ sourceKey: `${workspaceId}/source.jpg`, prompt: 'first' });
    expect(await db.generation.count({ where: { parentId: parent.id } })).toBe(1);
  });

  it('refuses a request whose params do not fit the capability, before any money moves', async () => {
    await expect(
      service.request({ workspaceId, requestedById: userId, capability: 'IMAGE_EDIT', clientKey: 'bad', params: { prompt: 'x' } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await db.generation.count({ where: { workspaceId } })).toBe(0);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);
  });

  it('puts a running generation back on the shelf without touching its credits', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    await service.requeue(generation.id, 'vendor hiccup');

    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(row.status).toBe('QUEUED');
    expect(row.attempts).toBe(1);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS - PRICE);

    // And the dispatcher sees it as an orphan once it is old enough.
    await db.generation.update({ where: { id: generation.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    // Without Redis nothing is dispatched (and nothing throws); with it —
    // the CI workflow runs one — the orphan is re-queued, alongside any older
    // QUEUED rows other specs left in the shared database.
    const dispatched = await service.redispatchOrphans();
    expect(dispatched.length === 0 || dispatched.includes(generation.id)).toBe(true);
  });

  it("tells the customer what happened in plain words, never the vendor's", async () => {
    const { generation } = await request();
    await service.start(generation.id);
    await service.fail(generation.id, { failureReason: 'fal.ai: HTTP 429 quota exceeded for model x', failureKind: 'RATE_LIMITED' });

    const view = await service.get(workspaceId, generation.id);
    expect(view.message).toMatch(/credits are back/);
    expect(view.message).not.toMatch(/fal|429|quota/);
  });

  it('never drifts: the derived balance always equals the sum of the entries', async () => {
    const a = await request();
    await service.start(a.generation.id);
    await service.succeed(a.generation.id, { outputs: [] });

    const b = await request();
    await service.start(b.generation.id);
    await service.fail(b.generation.id, { failureReason: 'nope' });

    const c = await request();
    await service.cancel(c.generation.id);

    expect(await ledger.drift(walletId)).toBe(0);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS - PRICE);
  });
});
