import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Actor } from '../auth/policy';
import { AdminService } from './admin.service';

const req = { ip: '127.0.0.1', requestId: 'gateway-test', get: () => undefined } as never;
const reason = 'Switch the card processor';
const actor: Actor = {
  userId: 'gateway-test',
  surface: 'ADMIN',
  staffRole: 'SUPERADMIN',
  mfaLevel: 2,
  lastStepUpAt: new Date(),
  impersonating: false,
  workspaceRoles: new Map(),
};

function service(db: unknown) {
  return new AdminService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
}

describe('gateway permissions and validation', () => {
  it('rejects unsupported gateways before touching the database', async () => {
    const db = { $transaction: vi.fn() };
    await expect(service(db).setGateway(actor, { key: 'unknown', enabled: true, reason }, req)).rejects.toMatchObject({
      code: 'invalid_input',
      details: { key: expect.stringContaining('Unknown gateway') },
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('requires a superadmin to read settings', async () => {
    await expect(service({}).gateways({ ...actor, staffRole: 'ADMIN' })).rejects.toThrow('Requires SUPERADMIN');
  });

  it.each([{ staffRole: 'ADMIN' }, { surface: 'APP' }, { lastStepUpAt: new Date(0) }, { impersonating: true }] as Partial<Actor>[])(
    'rejects an unauthorized mutation: %o',
    async (overrides) => {
      const db = { $transaction: vi.fn() };
      await expect(service(db).setGateway({ ...actor, ...overrides }, { key: 'stripe', enabled: true, reason }, req)).rejects.toThrow();
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
});

// Always exercised in CI against its disposable Postgres. These tests prove
// rollback and competing requests against the database, not a transaction mock.
describe.skipIf(!process.env.DATABASE_URL)('gateway switching in Postgres', () => {
  const db = new PrismaClient();
  const admin = service(db);
  const keys = ['stripe', 'paddle', 'flutterwave'];
  let original: Awaited<ReturnType<typeof db.paymentGateway.findMany>> | undefined;

  beforeEach(async () => {
    original ??= await db.paymentGateway.findMany({ where: { key: { in: keys } } });
    for (const key of keys) {
      const data = { enabled: key !== 'paddle', note: null };
      await db.paymentGateway.upsert({ where: { key }, create: { key, ...data }, update: data });
    }
  });

  afterAll(async () => {
    if (original) {
      await db.paymentGateway.deleteMany({ where: { key: { in: keys } } });
      if (original.length) await db.paymentGateway.createMany({ data: original });
    }
    await db.$disconnect();
  });

  it('switches both directions, accepts case-insensitive keys and leaves Flutterwave alone', async () => {
    const out = await admin.setGateway(actor, { key: 'PADDLE', enabled: true, reason }, req);
    expect(out.changed).toEqual([
      { key: 'paddle', enabled: true },
      { key: 'stripe', enabled: false },
    ]);
    expect(Object.fromEntries(out.gateways.map((g) => [g.key, g.enabled]))).toMatchObject({ stripe: false, paddle: true, flutterwave: true });
    await admin.setGateway(actor, { key: 'stripe', enabled: true, reason }, req);
    const rows = await admin.gateways(actor);
    expect(Object.fromEntries(rows.gateways.map((g) => [g.key, g.enabled]))).toMatchObject({ stripe: true, paddle: false, flutterwave: true });
  });

  it('can turn off a gateway without enabling another', async () => {
    await admin.setGateway(actor, { key: 'stripe', enabled: false, reason }, req);
    await admin.setGateway(actor, { key: 'flutterwave', enabled: false, reason }, req);
    expect(await db.paymentGateway.count({ where: { key: { in: keys }, enabled: true } })).toBe(0);
  });

  it('rolls back the new processor when retiring the old one fails', async () => {
    const failingDb = db.$extends({
      query: {
        paymentGateway: {
          upsert({ args, query }) {
            if (args.where.key === 'stripe') throw new Error('Simulated rival write failure');
            return query(args);
          },
        },
      },
    });
    await expect(service(failingDb).setGateway(actor, { key: 'paddle', enabled: true, reason }, req)).rejects.toThrow('Simulated rival write failure');
    expect(await db.paymentGateway.findUnique({ where: { key: 'stripe' } })).toMatchObject({ enabled: true });
    expect(await db.paymentGateway.findUnique({ where: { key: 'paddle' } })).toMatchObject({ enabled: false });
  });

  it('keeps the card processors exclusive when two admins switch concurrently', async () => {
    const results = await Promise.allSettled([
      admin.setGateway(actor, { key: 'paddle', enabled: true, reason }, req),
      admin.setGateway(actor, { key: 'stripe', enabled: true, reason }, req),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await db.paymentGateway.count({ where: { key: { in: ['stripe', 'paddle'] }, enabled: true } })).toBe(1);
    expect(await db.paymentGateway.findUnique({ where: { key: 'flutterwave' } })).toMatchObject({ enabled: true });
  });
});
