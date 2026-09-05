/**
 * The router and its breaker, against an in-memory table of rows.
 *
 * These are unit tests on purpose: the routing decision is pure logic over
 * rows, and the breaker is a state machine. The only database behaviour —
 * persisting breakerOpenedAt — is asserted through a fake that records the
 * write.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, ProviderModel } from '@prisma/client';
import type { Capability, ProviderInput, ProviderResult } from '@anystudio/shared';
import { ProviderRegistry } from './provider.registry';
import { ProviderRouter } from './provider.router';
import { BaseProvider } from './adapters/base';

class Fake extends BaseProvider {
  constructor(key: string, caps: Capability[]) {
    super(key, caps);
  }
  async generate(input: ProviderInput): Promise<ProviderResult> {
    return { providerKey: this.key, artifacts: [{ mime: 'text/plain', role: 'text', text: input.capability }] };
  }
}

function row(key: string, capability: Capability, extra: Partial<ProviderModel> = {}): ProviderModel {
  return {
    key,
    capability,
    priority: 10,
    costPerCall: 1,
    enabled: true,
    breakerOpenedAt: null,
    workspaceType: null,
    config: null,
    licenceNote: null,
    updatedAt: new Date(),
    ...extra,
  };
}

function fakeDb(rows: ProviderModel[]) {
  const writes: Array<{ key: string; openedAt: Date | null }> = [];
  const db = {
    providerModel: {
      findMany: async ({ where }: { where: { capability: Capability; OR: Array<{ workspaceType: string | null }>; key?: string | { notIn: string[] } } }) =>
        rows.filter(
          (r) =>
            r.capability === where.capability &&
            r.enabled &&
            where.OR.some((o) => o.workspaceType === r.workspaceType) &&
            (where.key === undefined || (typeof where.key === 'string' ? r.key === where.key : !where.key.notIn.includes(r.key))),
        ),
      updateMany: async ({ where, data }: { where: { key: string }; data: { breakerOpenedAt: Date | null } }) => {
        writes.push({ key: where.key, openedAt: data.breakerOpenedAt });
        for (const r of rows) if (r.key === where.key) r.breakerOpenedAt = data.breakerOpenedAt;
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  return { db, writes };
}

describe('ProviderRouter', () => {
  let registry: ProviderRegistry;
  beforeEach(() => {
    process.env.APP_ENV = 'production'; // no stub adapter, so only what we register is routable
    registry = new ProviderRegistry();
    registry.register(new Fake('a:cheap', ['IMAGE_EDIT']));
    registry.register(new Fake('b:good', ['IMAGE_EDIT']));
    registry.register(new Fake('c:bria', ['BACKGROUND_REMOVE']));
    registry.register(new Fake('d:birefnet', ['BACKGROUND_REMOVE']));
  });

  it('narrows to one vendor with `only`, drops `exclude`d ones, and lets `prefer` outrank priority', async () => {
    const { db } = fakeDb([row('a:cheap', 'IMAGE_EDIT', { priority: 10 }), row('b:good', 'IMAGE_EDIT', { priority: 20 })]);
    const router = new ProviderRouter(db, registry);
    expect((await router.route('IMAGE_EDIT', 'PERSONAL', { only: 'b:good' })).candidates.map((c) => c.row.key)).toEqual(['b:good']);
    expect((await router.route('IMAGE_EDIT', 'PERSONAL', { exclude: ['a:cheap'] })).candidates.map((c) => c.row.key)).toEqual(['b:good']);
    expect((await router.route('IMAGE_EDIT', 'PERSONAL', { prefer: ['b:good'] })).candidates.map((c) => c.row.key)).toEqual(['b:good', 'a:cheap']);
    expect((await router.route('IMAGE_EDIT', 'PERSONAL', { prefer: ['z:none'] })).candidates.map((c) => c.row.key)).toEqual(['a:cheap', 'b:good']);
  });

  it('orders candidates by priority and excludes rows with no adapter, with a reason', async () => {
    const { db } = fakeDb([
      row('b:good', 'IMAGE_EDIT', { priority: 20 }),
      row('a:cheap', 'IMAGE_EDIT', { priority: 10 }),
      row('z:nokey', 'IMAGE_EDIT', { priority: 1 }),
    ]);
    const router = new ProviderRouter(db, registry);
    const d = await router.route('IMAGE_EDIT', 'PERSONAL');

    expect(d.candidates.map((c) => c.row.key)).toEqual(['a:cheap', 'b:good']);
    expect(d.excluded).toEqual([{ key: 'z:nokey', reason: 'no adapter or credential in this process' }]);
  });

  it('routes an ORGANIZATION workspace to its tier row and everyone else to the general one', async () => {
    const { db } = fakeDb([
      row('d:birefnet', 'BACKGROUND_REMOVE', { priority: 10 }),
      row('c:bria', 'BACKGROUND_REMOVE', { priority: 5, workspaceType: 'ORGANIZATION' }),
    ]);
    const router = new ProviderRouter(db, registry);

    expect((await router.route('BACKGROUND_REMOVE', 'ORGANIZATION')).candidates.map((c) => c.row.key)).toEqual(['c:bria', 'd:birefnet']);
    expect((await router.route('BACKGROUND_REMOVE', 'BUSINESS')).candidates.map((c) => c.row.key)).toEqual(['d:birefnet']);
  });

  it('opens the breaker at once on PROVIDER_DOWN, persists it, and falls through to the next candidate', async () => {
    const { db, writes } = fakeDb([row('a:cheap', 'IMAGE_EDIT', { priority: 10 }), row('b:good', 'IMAGE_EDIT', { priority: 20 })]);
    const router = new ProviderRouter(db, registry);

    await router.report('a:cheap', 'IMAGE_EDIT', { ok: false, kind: 'PROVIDER_DOWN', latencyMs: 10 });
    expect(writes).toEqual([{ key: 'a:cheap', openedAt: expect.any(Date) }]);

    const d = await router.route('IMAGE_EDIT', 'PERSONAL');
    expect(d.candidates.map((c) => c.row.key)).toEqual(['b:good']);
    expect(d.excluded[0]).toMatchObject({ key: 'a:cheap', reason: expect.stringContaining('breaker open') });
  });

  it('trips on a sustained error rate, not on one bad call', async () => {
    const { db } = fakeDb([row('a:cheap', 'IMAGE_EDIT')]);
    const router = new ProviderRouter(db, registry);

    await router.report('a:cheap', 'IMAGE_EDIT', { ok: false, kind: 'RETRYABLE', latencyMs: 1 });
    expect((await router.route('IMAGE_EDIT', 'PERSONAL')).candidates).toHaveLength(1);

    for (let i = 0; i < 4; i++) await router.report('a:cheap', 'IMAGE_EDIT', { ok: false, kind: 'RETRYABLE', latencyMs: 1 });
    expect((await router.route('IMAGE_EDIT', 'PERSONAL')).candidates).toHaveLength(0);
  });

  it('ignores the customer-input failures when judging a provider', async () => {
    const { db } = fakeDb([row('a:cheap', 'IMAGE_EDIT')]);
    const router = new ProviderRouter(db, registry);
    for (let i = 0; i < 10; i++) await router.report('a:cheap', 'IMAGE_EDIT', { ok: false, kind: 'CONTENT_REJECTED', latencyMs: 1 });
    expect((await router.route('IMAGE_EDIT', 'PERSONAL')).candidates).toHaveLength(1);
  });

  it('half-opens after the cooldown: one probe, and a success closes it', async () => {
    const { db, writes } = fakeDb([row('a:cheap', 'IMAGE_EDIT')]);
    const router = new ProviderRouter(db, registry);
    await router.report('a:cheap', 'IMAGE_EDIT', { ok: false, kind: 'PROVIDER_DOWN', latencyMs: 1 });

    // Pretend a minute passed.
    const h = (router as unknown as { health: Map<string, { openedAt: number }> }).health.get('a:cheap|IMAGE_EDIT')!;
    h.openedAt = Date.now() - 61_000;

    const probe = await router.route('IMAGE_EDIT', 'PERSONAL');
    expect(probe.candidates).toHaveLength(1); // the probe goes through
    const second = await router.route('IMAGE_EDIT', 'PERSONAL');
    expect(second.candidates).toHaveLength(0); // nobody else while the probe is in flight

    await router.report('a:cheap', 'IMAGE_EDIT', { ok: true, latencyMs: 1 });
    expect(writes.at(-1)).toEqual({ key: 'a:cheap', openedAt: null });
    expect((await router.route('IMAGE_EDIT', 'PERSONAL')).candidates).toHaveLength(1);
  });
});
