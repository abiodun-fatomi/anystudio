import { describe, expect, it, vi } from 'vitest';
import type { Generation } from '@prisma/client';
import { AudioService } from './audio.service';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const generationId = '00000000-0000-4000-8000-000000000002';
const walletId = '00000000-0000-4000-8000-000000000003';

function harness() {
  let row = {
    id: generationId,
    workspaceId,
    capability: 'MUSIC',
    status: 'SUCCEEDED',
    deletedAt: null,
    createdAt: new Date('2026-09-07T00:00:00.000Z'),
    input: {},
    outputs: [
      {
        role: 'audio',
        key: `${workspaceId}/vault/2026/09/gen/${generationId}/song.mp3`,
        mime: 'audio/mpeg',
        bytes: 123,
        durationMs: 60_000,
        locked: true,
      },
    ],
  } as unknown as Generation;
  const entries: Array<{
    id: string;
    kind: 'DEBIT' | 'REFUND';
    idempotencyKey: string;
    walletId: string;
    referenceId: string;
    delta: number;
  }> = [];
  let tail = Promise.resolve();

  const tx = {
    $queryRaw: vi.fn(async () => [{ acquired: true }]),
    generation: {
      findFirst: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: { outputs: unknown; input: unknown } }) => {
        row = { ...row, outputs: data.outputs, input: data.input } as Generation;
        return row;
      }),
    },
    wallet: { findUniqueOrThrow: vi.fn(async () => ({ id: walletId })) },
    creditCost: { findUnique: vi.fn(async () => ({ code: 'music.unlock', credits: 30, label: 'Unlock full song' })) },
    ledgerEntry: {
      findMany: vi.fn(async () => entries.map(({ kind, idempotencyKey }) => ({ kind, idempotencyKey }))),
    },
    mediaAsset: { upsert: vi.fn(async ({ create }: { create: object }) => create) },
  };
  const db = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const rowBefore = structuredClone(row);
      const entriesBefore = structuredClone(entries);
      try {
        return await callback(tx);
      } catch (error) {
        row = rowBefore;
        entries.splice(0, entries.length, ...entriesBefore);
        throw error;
      } finally {
        release();
      }
    }),
  };
  const ledger = {
    debit: vi.fn(async (move: { idempotencyKey: string }) => {
      const existing = entries.find((entry) => entry.idempotencyKey === move.idempotencyKey);
      if (existing) return existing;
      const entry = {
        id: `debit-${entries.length + 1}`,
        kind: 'DEBIT' as const,
        idempotencyKey: move.idempotencyKey,
        walletId,
        referenceId: generationId,
        delta: -30,
      };
      entries.push(entry);
      return entry;
    }),
    refund: vi.fn(async (move: { idempotencyKey: string }) => {
      const key = `${move.idempotencyKey}:refund`;
      const existing = entries.find((entry) => entry.idempotencyKey === key);
      if (existing) return existing;
      const entry = {
        id: `refund-${entries.length + 1}`,
        kind: 'REFUND' as const,
        idempotencyKey: key,
        walletId,
        referenceId: generationId,
        delta: 30,
      };
      entries.push(entry);
      return entry;
    }),
  };
  const media = {
    copy: vi.fn(async () => undefined),
    recordOutput: vi.fn(async (input: object) => input),
    readUrls: vi.fn(async (_workspaceId: string, keys: string[]) => Object.fromEntries(keys.map((key) => [key, `signed:${key}`]))),
  };
  const service = new AudioService(db as never, ledger as never, media as never, {} as never);
  const actor = { userId: '00000000-0000-4000-8000-000000000004' } as never;
  const req = { ip: '127.0.0.1', requestId: 'test', get: () => 'vitest' } as never;
  return { service, actor, req, db, tx, ledger, media, entries, row: () => row };
}

describe('AudioService unlock charging', () => {
  it('serializes concurrent unlocks so exactly one copy and debit can commit', async () => {
    const h = harness();
    h.media.copy.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    const results = await Promise.all([
      h.service.unlock(h.actor, workspaceId, generationId, h.req),
      h.service.unlock(h.actor, workspaceId, generationId, h.req),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['already_unlocked', 'unlocked']);
    expect(h.media.copy).toHaveBeenCalledTimes(1);
    expect(h.media.recordOutput).toHaveBeenCalledTimes(1);
    expect(h.ledger.debit).toHaveBeenCalledTimes(1);
    expect(h.ledger.refund).not.toHaveBeenCalled();
    expect(h.entries.map((entry) => entry.idempotencyKey)).toEqual([`unlock:${generationId}`]);
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(h.db.$transaction).toHaveBeenCalledTimes(2);
  });

  it('refunds a failed copy and charges a fresh attempt on retry', async () => {
    const h = harness();
    h.media.copy.mockRejectedValueOnce(new Error('R2 unavailable'));

    await expect(h.service.unlock(h.actor, workspaceId, generationId, h.req)).rejects.toThrow('Nothing was charged');
    const retry = await h.service.unlock(h.actor, workspaceId, generationId, h.req);

    expect(retry.status).toBe('unlocked');
    expect(h.ledger.debit.mock.calls.map(([move]) => move.idempotencyKey)).toEqual([`unlock:${generationId}`, `unlock:${generationId}:attempt:2`]);
    expect(h.ledger.refund).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `unlock:${generationId}` }), h.tx);
    expect(h.entries.map((entry) => entry.idempotencyKey)).toEqual([
      `unlock:${generationId}`,
      `unlock:${generationId}:refund`,
      `unlock:${generationId}:attempt:2`,
    ]);
    expect(h.entries.reduce((total, entry) => total + entry.delta, 0)).toBe(-30);
  });

  it('resumes a legacy outstanding debit at its original price', async () => {
    const h = harness();
    h.entries.push({
      id: 'legacy',
      kind: 'DEBIT',
      idempotencyKey: `unlock:${generationId}`,
      walletId,
      referenceId: generationId,
      delta: -17,
    });

    const result = await h.service.unlock(h.actor, workspaceId, generationId, h.req);

    expect(result).toMatchObject({ status: 'unlocked', credits: 17 });
    expect(h.entries).toHaveLength(1);
    expect(h.ledger.refund).not.toHaveBeenCalled();
    expect((h.row().input as { unlockLedgerEntryId?: string }).unlockLedgerEntryId).toBe('legacy');
  });

  it('rolls the debit and database state back when output recording fails after the copy', async () => {
    const h = harness();
    h.media.recordOutput.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(h.service.unlock(h.actor, workspaceId, generationId, h.req)).rejects.toThrow('database unavailable');

    expect(h.media.copy).toHaveBeenCalledTimes(1);
    expect(h.entries).toEqual([]);
    expect((h.row().outputs as Array<{ locked?: boolean }>)[0]?.locked).toBe(true);
  });

  it('fails closed when an idempotency collision resolves to the wrong debit', async () => {
    const h = harness();
    h.ledger.debit.mockResolvedValueOnce({
      id: 'collision',
      kind: 'REFUND',
      idempotencyKey: `unlock:${generationId}`,
      walletId,
      referenceId: generationId,
      delta: 30,
    });

    await expect(h.service.unlock(h.actor, workspaceId, generationId, h.req)).rejects.toThrow('did not resolve to the expected ledger entry');
    expect(h.media.copy).not.toHaveBeenCalled();
    expect(h.entries).toEqual([]);
  });

  it('fails closed and rolls back when a refund idempotency collision has the wrong amount', async () => {
    const h = harness();
    h.media.copy.mockRejectedValueOnce(Object.assign(new Error('copy timed out'), { name: 'AbortError' }));
    h.ledger.refund.mockResolvedValueOnce({
      id: 'collision',
      kind: 'REFUND',
      idempotencyKey: `unlock:${generationId}:refund`,
      walletId,
      referenceId: generationId,
      delta: 1,
    });

    await expect(h.service.unlock(h.actor, workspaceId, generationId, h.req)).rejects.toThrow('did not resolve to the expected ledger entry');
    expect(h.entries).toEqual([]);
    expect((h.row().outputs as Array<{ locked?: boolean }>)[0]?.locked).toBe(true);
  });

  it('fails fast without charging when another replica holds the song lock', async () => {
    const h = harness();
    h.tx.$queryRaw.mockResolvedValueOnce([{ acquired: false }]);

    await expect(h.service.unlock(h.actor, workspaceId, generationId, h.req)).rejects.toThrow('already being unlocked');
    expect(h.ledger.debit).not.toHaveBeenCalled();
    expect(h.media.copy).not.toHaveBeenCalled();
  });

  it('fails closed when historical corruption left two unrefunded attempts', async () => {
    const h = harness();
    h.entries.push(
      { id: 'legacy', kind: 'DEBIT', idempotencyKey: `unlock:${generationId}`, walletId, referenceId: generationId, delta: -30 },
      { id: 'second', kind: 'DEBIT', idempotencyKey: `unlock:${generationId}:attempt:2`, walletId, referenceId: generationId, delta: -30 },
    );

    await expect(h.service.unlock(h.actor, workspaceId, generationId, h.req)).rejects.toThrow('Multiple outstanding unlock debits');
    expect(h.media.copy).not.toHaveBeenCalled();
  });
});
