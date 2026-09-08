import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, ProviderAttempt, ProviderModel } from '@prisma/client';
import { ProviderError, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from '../modules/provider/adapters/base';
import type { RouteCandidate } from '../modules/provider/provider.router';
import { ProviderAttemptJournal, providerOperationSignature } from './provider-attempts';

class FakeProvider extends BaseProvider {
  constructor() {
    super('fal:test', ['IMAGE_EDIT']);
  }
  generate(_input: ProviderInput, _opts: ProviderOpts): Promise<ProviderResult> {
    return Promise.resolve({ providerKey: this.key, artifacts: [] });
  }
}

function route(): RouteCandidate {
  return {
    row: {
      key: 'fal:test',
      capability: 'IMAGE_EDIT',
      priority: 10,
      costPerCall: 5,
      enabled: true,
      breakerOpenedAt: null,
      workspaceType: null,
      config: null,
      licenceNote: 'test',
      updatedAt: new Date(),
    } as ProviderModel,
    provider: new FakeProvider(),
  };
}

function input(url = 'https://r2.example/ws/source.png?X-Amz-Signature=one'): Omit<ProviderInput, 'config'> {
  return {
    generationId: '00000000-0000-0000-0000-000000000001',
    workspaceId: '00000000-0000-0000-0000-000000000002',
    capability: 'IMAGE_EDIT',
    params: { sourceKey: 'ws/source.png', prompt: 'new room' },
    files: { sourceKey: { key: 'ws/source.png', url, mime: 'image/png', bytes: 123 } },
  };
}

function fakeDb(seed: ProviderAttempt[] = []) {
  const attempts = [...seed];
  let ids = attempts.length;
  const delegate = {
    findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
      const statuses = ((where.status as { in?: string[] } | undefined)?.in ?? []) as string[];
      return attempts
        .filter(
          (row) =>
            row.generationId === where.generationId && row.operationKey === where.operationKey && (statuses.length === 0 || statuses.includes(row.status)),
        )
        .slice(0, take);
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        attempts
          .filter((row) => row.generationId === where.generationId && row.operationKey === where.operationKey && row.providerKey === where.providerKey)
          .sort((a, b) => b.submissionNo - a.submissionNo)[0] ?? null
      );
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => attempts.find((row) => row.id === where.id) ?? null),
    create: vi.fn(async ({ data }: { data: Partial<ProviderAttempt> }) => {
      const now = new Date();
      const row = {
        id: `00000000-0000-0000-0000-${String(++ids).padStart(12, '0')}`,
        providerJobId: null,
        costMinor: null,
        resumeData: null,
        errorKind: null,
        errorMessage: null,
        submittedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      } as ProviderAttempt;
      attempts.push(row);
      return row;
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status?: string | { in: string[] }; costMinor?: number | null }; data: Partial<ProviderAttempt> }) => {
        const row = attempts.find((item) => item.id === where.id);
        const allowed = typeof where.status === 'string' ? row?.status === where.status : !where.status || where.status.in.includes(row!.status);
        const costMatches = where.costMinor === undefined || row?.costMinor === where.costMinor;
        if (!row || !allowed || !costMatches) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date() });
        return { count: 1 };
      },
    ),
    aggregate: vi.fn(async ({ where }: { where: { generationId: string; status: string } }) => ({
      _sum: {
        costMinor: attempts
          .filter((row) => row.generationId === where.generationId && row.status === where.status)
          .reduce((sum, row) => sum + (row.costMinor ?? 0), 0),
      },
    })),
  };
  const db = {
    providerAttempt: delegate,
    providerModel: { findUnique: vi.fn(async () => route().row) },
    generation: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db: db as unknown as PrismaClient, attempts, generation: db.generation };
}

describe('provider attempt journal', () => {
  it('keeps operation ids stable across regenerated signed URLs and preserves intentional call order', () => {
    expect(providerOperationSignature(input('?ignored'))).not.toBe('');
    expect(providerOperationSignature(input('https://r2.example/ws/source.png?sig=one'))).toBe(
      providerOperationSignature(input('https://new-cdn.example/bucket/path-style/changed?sig=two')),
    );
    const a = new ProviderAttemptJournal(fakeDb().db, input().generationId, 1);
    const b = new ProviderAttemptJournal(fakeDb().db, input().generationId, 2);
    expect(a.nextOperation(input())).toBe(b.nextOperation(input()));
    expect(a.nextOperation(input())).toMatch(/:1$/);
  });

  it('records successful spend once and never lets a late callback overwrite or downgrade it', async () => {
    const f = fakeDb();
    const journal = new ProviderAttemptJournal(f.db, input().generationId, 1);
    const handle = await journal.begin(journal.nextOperation(input()), route());
    await journal.settled(handle.row.id, 'SUCCEEDED'); // adapter callback arrives before the runner knows dynamic cost
    await journal.settled(handle.row.id, 'SUCCEEDED', undefined, 7.2);
    await journal.settled(handle.row.id, 'SUCCEEDED', undefined, 99);
    await journal.settled(handle.row.id, 'FAILED', new ProviderError('RETRYABLE', 'late socket error', 'fal:test'));

    expect(f.attempts[0]).toMatchObject({ status: 'SUCCEEDED', costMinor: 8 });
    await expect(journal.totalCostMinor()).resolves.toBe(8);
  });

  it('persists an accepted id before polling and resumes the same job on a new worker attempt', async () => {
    const f = fakeDb();
    const first = new ProviderAttemptJournal(f.db, input().generationId, 1);
    const operation = first.nextOperation(input());
    const handle = await first.begin(operation, route());
    await first.submitted(handle.row.id, 'fal:test', 'job-1', { statusUrl: 'https://fal/status/1', responseUrl: 'https://fal/result/1' });

    const next = new ProviderAttemptJournal(f.db, input().generationId, 2);
    const outstanding = await next.outstanding(operation, { get: () => route().provider } as never, [route()]);
    expect(outstanding?.row.key).toBe('fal:test');
    const resumed = await next.begin(operation, outstanding!);
    expect(resumed.resume).toEqual({
      providerJobId: 'job-1',
      data: { statusUrl: 'https://fal/status/1', responseUrl: 'https://fal/result/1' },
    });
    expect(f.generation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { providerKey: 'fal:test', providerJobId: 'job-1' } }));
  });

  it('fails closed when the POST may have landed but no job id was persisted', async () => {
    const f = fakeDb();
    const journal = new ProviderAttemptJournal(f.db, input().generationId, 1);
    const operation = journal.nextOperation(input());
    await journal.begin(operation, route());

    await expect(journal.outstanding(operation, { get: () => route().provider } as never, [route()])).rejects.toMatchObject({
      kind: 'SUBMISSION_UNKNOWN',
    });
    expect(f.attempts).toHaveLength(1);
  });

  it('allows a new submission only after a definitive terminal failure', async () => {
    const f = fakeDb();
    const first = new ProviderAttemptJournal(f.db, input().generationId, 1);
    const operation = first.nextOperation(input());
    const handle = await first.begin(operation, route());
    await first.submitted(handle.row.id, 'fal:test', 'job-1');
    await first.settled(handle.row.id, 'FAILED');
    await expect(
      first.guardFailure(handle.row, new ProviderError('RETRYABLE', 'vendor says failed', 'fal:test', { providerJobId: 'job-1' })),
    ).resolves.toBeUndefined();

    const second = new ProviderAttemptJournal(f.db, input().generationId, 2);
    const retry = await second.begin(operation, route());
    expect(retry.row.submissionNo).toBe(2);
    expect(retry.resume).toBeUndefined();
  });

  it('does not pretend a successful synchronous response is resumable', async () => {
    const f = fakeDb();
    const journal = new ProviderAttemptJournal(f.db, input().generationId, 1);
    const operation = journal.nextOperation(input());
    const handle = await journal.begin(operation, route());
    await journal.settled(handle.row.id, 'SUCCEEDED');
    await expect(journal.outstanding(operation, { get: () => route().provider } as never, [route()])).rejects.toMatchObject({
      kind: 'SUBMISSION_UNKNOWN',
    });
  });
});
