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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { GenerationService } from './generation.service';
import { LedgerService } from '../ledger/ledger.service';
import { AppError } from '../../../config/globals/errors';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('GenerationService', () => {
  const db = new PrismaClient();
  const ledger = new LedgerService(db);
  const service = new GenerationService(db, ledger);

  let workspaceId: string;
  let userId: string;
  let walletId: string;

  const COST = 'test.image';
  const PRICE = 10;
  const STARTING_CREDITS = 100;

  beforeAll(async () => {
    await db.$connect();
    await db.creditCost.upsert({
      where: { code: COST },
      create: { code: COST, credits: PRICE, label: 'Test image' },
      update: { credits: PRICE, label: 'Test image' },
    });
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

  const request = () => service.request({ workspaceId, requestedById: userId, costCode: COST, input: { key: 'a.webp' } });

  it('debits the credits when the generation is requested, not when it succeeds', async () => {
    const { generation, balance } = await request();

    expect(generation.status).toBe('QUEUED');
    expect(generation.credits).toBe(PRICE);
    expect(balance).toBe(STARTING_CREDITS - PRICE);
  });

  it('copies the price onto the row, so a later price change cannot rewrite history', async () => {
    const { generation } = await request();
    await db.creditCost.update({ where: { code: COST }, data: { credits: 999 } });

    const reread = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(reread.credits).toBe(PRICE);

    await db.creditCost.update({ where: { code: COST }, data: { credits: PRICE } });
  });

  it('writes no row at all when the wallet cannot afford it', async () => {
    await db.creditCost.update({ where: { code: COST }, data: { credits: STARTING_CREDITS + 1 } });
    try {
      await expect(request()).rejects.toMatchObject({ code: 'insufficient_credits', status: 402 });
      expect(await db.generation.count({ where: { workspaceId } })).toBe(0);
      expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);
    } finally {
      await db.creditCost.update({ where: { code: COST }, data: { credits: PRICE } });
    }
  });

  it('refunds when the generation fails', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    const failed = await service.fail(generation.id, { failureReason: 'provider timed out' });

    expect(failed.status).toBe('FAILED');
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);
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
    const done = await service.succeed(generation.id, { outputs: { keys: ['out.webp'] }, providerJobId: 'p-1' });

    expect(done.status).toBe('SUCCEEDED');
    expect(done.providerJobId).toBe('p-1');
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS - PRICE);
  });

  it('will not un-refund a failed generation if the provider answers late', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    await service.fail(generation.id, { failureReason: 'timed out' });

    await expect(service.succeed(generation.id, { outputs: {} })).rejects.toBeInstanceOf(AppError);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);
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

  it('reclaims and refunds a generation whose worker went silent', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    // Backdate the heartbeat rather than waiting fifteen minutes.
    await db.generation.update({
      where: { id: generation.id },
      data: { heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const reclaimed = await service.sweepStale();

    expect(reclaimed).toContain(generation.id);
    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(row.status).toBe('FAILED');
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS);
  });

  it('leaves a generation alone while its worker is still checking in', async () => {
    const { generation } = await request();
    await service.start(generation.id);
    await service.heartbeat(generation.id);

    expect(await service.sweepStale()).not.toContain(generation.id);
    const row = await db.generation.findUniqueOrThrow({ where: { id: generation.id } });
    expect(row.status).toBe('RUNNING');
  });

  it('never drifts: the derived balance always equals the sum of the entries', async () => {
    const a = await request();
    await service.start(a.generation.id);
    await service.succeed(a.generation.id, { outputs: {} });

    const b = await request();
    await service.start(b.generation.id);
    await service.fail(b.generation.id, { failureReason: 'nope' });

    const c = await request();
    await service.cancel(c.generation.id);

    expect(await ledger.drift(walletId)).toBe(0);
    expect(await ledger.balance(walletId)).toBe(STARTING_CREDITS - PRICE);
  });
});
