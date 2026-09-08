import { describe, expect, it, vi } from 'vitest';
import type { Generation } from '@prisma/client';
import { ProviderError, type Capability, type GenerationProvider, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import type { ProviderModel } from '@prisma/client';
import { BaseProvider } from '../modules/provider/adapters/base';
import type { RouteCandidate } from '../modules/provider/provider.router';
import { GenerationRunner } from './runner';
import type { ProviderAttemptJournal } from './provider-attempts';

class TimedProvider extends BaseProvider {
  constructor(
    key: string,
    private readonly answer: (opts: ProviderOpts) => Promise<ProviderResult>,
  ) {
    super(key, ['IMAGE_EDIT']);
  }

  generate(_input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    return this.answer(opts);
  }
}

function candidate(key: string, answer: (opts: ProviderOpts) => Promise<ProviderResult>): RouteCandidate {
  return {
    row: {
      key,
      capability: 'IMAGE_EDIT',
      priority: 10,
      costPerCall: 1,
      enabled: true,
      breakerOpenedAt: null,
      workspaceType: null,
      config: null,
      licenceNote: null,
      updatedAt: new Date(),
    } as ProviderModel,
    provider: new TimedProvider(key, answer),
  };
}

const row = (capability: Generation['capability'], kind: Generation['kind'] = 'STANDALONE'): Generation =>
  ({
    id: `generation-${capability}`,
    workspaceId: 'workspace-1',
    capability,
    kind,
    input: {},
    attempts: 1,
    credits: 0,
    costCode: 'test',
    parentId: null,
  }) as Generation;

function runnerFor(generation: Generation, resume: boolean) {
  const generations = {
    start: vi.fn(async () => (resume ? null : generation)),
    resume: vi.fn(async () => (resume ? generation : null)),
    heartbeat: vi.fn(),
    succeed: vi.fn(async () => ({ providerKey: null })),
    requeue: vi.fn(async () => true),
    retryParentAssembly: vi.fn(async () => true),
    fail: vi.fn(),
  };
  const events = { stage: vi.fn(async () => undefined), publish: vi.fn(async () => undefined) };
  const router = { route: vi.fn(async () => ({ candidates: [], excluded: [] })), report: vi.fn(async () => undefined) };
  const pipelines = { run: vi.fn(async () => ({ artifacts: [] })) };
  const queue = { enqueue: vi.fn(async () => ({ queued: true })) };
  const db = {
    workspace: { findUnique: vi.fn(async () => ({ id: 'workspace-1', type: 'BUSINESS', profile: null })) },
    brandKit: { findUnique: vi.fn(async () => null) },
    providerAttempt: { aggregate: vi.fn(async () => ({ _sum: { costMinor: null } })) },
    generation: { aggregate: vi.fn(async () => ({ _sum: { providerCostMinor: null } })) },
  };
  const runner = new GenerationRunner(
    db as never,
    generations as never,
    events as never,
    {} as never,
    router as never,
    queue as never,
    pipelines as never,
    { keys: () => [], get: () => undefined } as never,
  );
  return { runner, router, pipelines, generations, queue };
}

describe('local and parent pipeline routing', () => {
  it.each([
    ['COLLAGE', 'STANDALONE', false],
    ['BATCH', 'PARENT', false],
    ['IMAGE_TO_VIDEO', 'PARENT', true],
  ] as const)('runs %s/%s without requiring a top-level provider route', async (capability, kind, resume) => {
    const fixture = runnerFor(row(capability, kind), resume);
    await expect(fixture.runner.run(`generation-${capability}`)).resolves.toBe('succeeded');
    expect(fixture.pipelines.run).toHaveBeenCalledOnce();
    expect(fixture.router.route).not.toHaveBeenCalled();
  });

  it.each([
    ['IMAGE_TO_VIDEO', 'VIDEO_STITCH', 'ffmpeg stopped'],
    ['BATCH', 'BATCH', 'batch gather stopped'],
  ] as const)('keeps a retryable %s parent assembly on its resume queue', async (capability, queuedCapability, reason) => {
    const parent = { ...row(capability, 'PARENT'), stage: 'composing', attempts: 2 } as Generation;
    const fixture = runnerFor(parent, true);
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const outcome = await (
      fixture.runner as unknown as {
        handleFailure(row: Generation, error: unknown, startedAt: number, log: typeof log): Promise<string>;
      }
    ).handleFailure(parent, new ProviderError('RETRYABLE', reason, capability === 'IMAGE_TO_VIDEO' ? 'local:ffmpeg' : 'batch'), Date.now(), log);

    expect(outcome).toBe('requeued');
    expect(fixture.generations.retryParentAssembly).toHaveBeenCalledWith(parent.id, reason);
    expect(fixture.generations.requeue).not.toHaveBeenCalled();
    expect(fixture.queue.enqueue).toHaveBeenCalledWith(parent.id, queuedCapability, { delayMs: 60_000 });
  });
});

describe('provider fallback deadline', () => {
  type CallFallback = (
    candidates: RouteCandidate[],
    input: Omit<ProviderInput, 'config'>,
    opts: ProviderOpts & { generationId: string; operationKey?: string; providerAttempts?: ProviderAttemptJournal },
    log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> },
  ) => Promise<ProviderResult>;

  const input: Omit<ProviderInput, 'config'> = {
    generationId: 'generation-IMAGE_EDIT',
    workspaceId: 'workspace-1',
    capability: 'IMAGE_EDIT' as Capability,
    params: { sourceKey: 'source', prompt: 'new scene', preserveProduct: true, aspect: '1:1', sizes: [] },
    files: { sourceKey: { url: 'https://example.test/source.png', mime: 'image/png' } },
  };

  it('does not call a second paid provider after the first rejects the request', async () => {
    const fixture = runnerFor(row('IMAGE_EDIT'), false);
    const first = vi.fn(async (): Promise<ProviderResult> => {
      throw new ProviderError('REQUEST_REJECTED', 'unsupported source media', 'first', { status: 422 });
    });
    const second = vi.fn(async (): Promise<ProviderResult> => ({ providerKey: 'second', artifacts: [] }));
    const call = (fixture.runner as unknown as { callWithFallback: CallFallback }).callWithFallback.bind(fixture.runner);

    await expect(
      call(
        [candidate('first', first), candidate('second', second)],
        input,
        { generationId: 'g1', timeoutMs: 1_000, signal: new AbortController().signal },
        {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ kind: 'REQUEST_REJECTED', providerKey: 'first', meta: { status: 422 } });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it('may use an unpaid fallback when an adapter rejects its own request before submission', async () => {
    const fixture = runnerFor(row('IMAGE_EDIT'), false);
    const first = vi.fn(async (): Promise<ProviderResult> => {
      throw new ProviderError('INVALID_INPUT', 'adapter has no mapping for this mode', 'first');
    });
    const second = vi.fn(async (): Promise<ProviderResult> => ({ providerKey: 'second', artifacts: [] }));
    const call = (fixture.runner as unknown as { callWithFallback: CallFallback }).callWithFallback.bind(fixture.runner);

    const result = await call(
      [candidate('first', first), candidate('second', second)],
      input,
      { generationId: 'g1', timeoutMs: 1_000, signal: new AbortController().signal },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );

    expect(result.providerKey).toBe('second');
    expect(second).toHaveBeenCalledOnce();
  });

  it.each([
    [{ status: 400 }, 'remote HTTP metadata'],
    [{ providerJobId: 'paid-job-1' }, 'submitted-job metadata'],
  ] as const)('fails closed on a legacy INVALID_INPUT carrying %s', async (meta) => {
    const fixture = runnerFor(row('IMAGE_EDIT'), false);
    const second = vi.fn(async (): Promise<ProviderResult> => ({ providerKey: 'second', artifacts: [] }));
    const call = (fixture.runner as unknown as { callWithFallback: CallFallback }).callWithFallback.bind(fixture.runner);

    await expect(
      call(
        [
          candidate('first', async () => {
            throw new ProviderError('INVALID_INPUT', 'legacy classification', 'first', meta);
          }),
          candidate('second', second),
        ],
        input,
        { generationId: 'g1', timeoutMs: 1_000, signal: new AbortController().signal },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT', providerKey: 'first' });
    expect(second).not.toHaveBeenCalled();
  });

  it('gives a fallback only the wall-clock budget left by the previous candidate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const fixture = runnerFor(row('IMAGE_EDIT'), false);
      const seen: number[] = [];
      const candidates = [
        candidate('first', async (opts) => {
          seen.push(opts.timeoutMs);
          vi.setSystemTime(1_650);
          throw new ProviderError('RETRYABLE', 'first failed', 'first');
        }),
        candidate('second', async (opts) => {
          seen.push(opts.timeoutMs);
          return { providerKey: 'second', artifacts: [{ mime: 'image/png', role: 'image', bytes: new Uint8Array([1]) }] };
        }),
      ];
      const call = (fixture.runner as unknown as { callWithFallback: CallFallback }).callWithFallback.bind(fixture.runner);
      const result = await call(
        candidates,
        input,
        { generationId: 'g1', timeoutMs: 1_000, signal: new AbortController().signal },
        {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      );

      expect(result.providerKey).toBe('second');
      expect(seen).toEqual([1_000, 350]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call another provider after the aggregate budget is exhausted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const fixture = runnerFor(row('IMAGE_EDIT'), false);
      const second = vi.fn(async (): Promise<ProviderResult> => ({ providerKey: 'second', artifacts: [] }));
      const candidates = [
        candidate('first', async () => {
          vi.setSystemTime(2_001);
          throw new ProviderError('RETRYABLE', 'first timed out', 'first');
        }),
        candidate('second', second),
      ];
      const call = (fixture.runner as unknown as { callWithFallback: CallFallback }).callWithFallback.bind(fixture.runner);

      await expect(
        call(
          candidates,
          input,
          { generationId: 'g1', timeoutMs: 1_000, signal: new AbortController().signal },
          {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
        ),
      ).rejects.toMatchObject({ kind: 'RETRYABLE', providerKey: 'runner', message: expect.stringContaining('budget exhausted') });
      expect(second).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces the aggregate deadline even when an adapter never settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const fixture = runnerFor(row('IMAGE_EDIT'), false);
      const first = vi.fn(() => new Promise<ProviderResult>(() => undefined));
      const second = vi.fn(async (): Promise<ProviderResult> => ({ providerKey: 'second', artifacts: [] }));
      const call = (fixture.runner as unknown as { callWithFallback: CallFallback }).callWithFallback.bind(fixture.runner);
      const result = call(
        [candidate('first', first), candidate('second', second)],
        input,
        { generationId: 'g1', timeoutMs: 1_000, signal: new AbortController().signal },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      );
      const rejected = expect(result).rejects.toMatchObject({ kind: 'RETRYABLE', providerKey: 'runner' });

      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes an outstanding job as the only candidate even when routing also offers a fallback', async () => {
    const fixture = runnerFor(row('IMAGE_EDIT'), false);
    const first = vi.fn(async (opts: ProviderOpts): Promise<ProviderResult> => {
      expect(opts.resume).toEqual({ providerJobId: 'job-1', data: { pollUrl: 'https://provider.test/job-1' } });
      return { providerKey: 'first', providerJobId: 'job-1', artifacts: [] };
    });
    const second = vi.fn(async (): Promise<ProviderResult> => ({ providerKey: 'second', artifacts: [] }));
    const firstCandidate = candidate('first', first);
    const attempt = { id: 'attempt-1', status: 'SUBMITTED', providerJobId: 'job-1' };
    const journal = {
      outstanding: vi.fn(async () => firstCandidate),
      begin: vi.fn(async () => ({ row: attempt, resume: { providerJobId: 'job-1', data: { pollUrl: 'https://provider.test/job-1' } } })),
      settled: vi.fn(async () => undefined),
      submitted: vi.fn(async () => undefined),
      guardFailure: vi.fn(async () => undefined),
    } as unknown as ProviderAttemptJournal;
    const call = (fixture.runner as unknown as { callWithFallback: CallFallback }).callWithFallback.bind(fixture.runner);

    await expect(
      call(
        [firstCandidate, candidate('second', second)],
        input,
        { generationId: 'g1', operationKey: 'op-1', providerAttempts: journal, timeoutMs: 1_000, signal: new AbortController().signal },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ),
    ).resolves.toMatchObject({ providerKey: 'first', providerJobId: 'job-1' });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it('does not fall back while a submitted job has only a transient polling failure', async () => {
    const fixture = runnerFor(row('IMAGE_EDIT'), false);
    const first = vi.fn(async (opts: ProviderOpts): Promise<ProviderResult> => {
      await opts.onSubmitted?.('job-live');
      throw new ProviderError('RETRYABLE', 'poll timed out', 'first', { providerJobId: 'job-live' });
    });
    const second = vi.fn(async (): Promise<ProviderResult> => ({ providerKey: 'second', artifacts: [] }));
    const attempt = { id: 'attempt-1', status: 'SUBMITTING', providerJobId: null };
    const journal = {
      outstanding: vi.fn(async () => null),
      begin: vi.fn(async () => ({ row: attempt })),
      submitted: vi.fn(async () => {
        attempt.status = 'SUBMITTED';
        attempt.providerJobId = 'job-live';
      }),
      settled: vi.fn(async () => undefined),
      guardFailure: vi.fn(async () => {
        throw new ProviderError('RETRYABLE', 'poll timed out', 'first', { providerJobId: 'job-live' });
      }),
    } as unknown as ProviderAttemptJournal;
    const call = (fixture.runner as unknown as { callWithFallback: CallFallback }).callWithFallback.bind(fixture.runner);

    await expect(
      call(
        [candidate('first', first), candidate('second', second)],
        input,
        { generationId: 'g1', operationKey: 'op-1', providerAttempts: journal, timeoutMs: 1_000, signal: new AbortController().signal },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ),
    ).rejects.toMatchObject({ kind: 'RETRYABLE', meta: { providerJobId: 'job-live' } });
    expect(second).not.toHaveBeenCalled();
  });
});

describe('paid side-door routing', () => {
  type CallExternal = <T>(
    journal: ProviderAttemptJournal,
    provider: GenerationProvider,
    workspaceType: 'PERSONAL' | 'BUSINESS' | 'ORGANIZATION',
    input: Omit<ProviderInput, 'config'>,
    execute: (opts: ProviderOpts) => Promise<T>,
    opts: Pick<ProviderOpts, 'timeoutMs' | 'signal' | 'onProgress'> & { costMinor?: number | ((result: T) => number) },
    log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> },
  ) => Promise<T>;

  const externalInput: Omit<ProviderInput, 'config'> = {
    generationId: 'g1',
    workspaceId: 'workspace-1',
    capability: 'LIPSYNC',
    params: { sourceKey: 'video', audioKey: 'audio' },
    files: {},
  };

  const journal = (outstanding: RouteCandidate | null, resumed = false) =>
    ({
      nextOperation: vi.fn(() => 'external-op'),
      outstanding: vi.fn(async () => outstanding),
      begin: vi.fn(async () => ({
        row: { id: 'attempt-1' },
        ...(resumed ? { resume: { providerJobId: 'paid-job-1', data: { pollUrl: 'https://vendor.test/jobs/1' } } } : {}),
      })),
      submitted: vi.fn(async () => undefined),
      settled: vi.fn(async () => undefined),
      guardFailure: vi.fn(async () => undefined),
    }) as unknown as ProviderAttemptJournal;

  it('blocks a fresh side-door POST when the exact provider is disabled or its breaker is open', async () => {
    const fixture = runnerFor(row('LIPSYNC'), false);
    const paid = candidate('paid:presenter', async () => ({ providerKey: 'paid:presenter', artifacts: [] }));
    const execute = vi.fn(async () => ({ url: 'https://vendor.test/result.mp4' }));
    const attempts = journal(null);
    const call = (fixture.runner as unknown as { callExternal: CallExternal }).callExternal.bind(fixture.runner);

    await expect(
      call(
        attempts,
        paid.provider,
        'BUSINESS',
        externalInput,
        execute,
        { timeoutMs: 1_000, signal: new AbortController().signal },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ),
    ).rejects.toMatchObject({ kind: 'PROVIDER_DOWN', providerKey: 'paid:presenter' });
    expect(fixture.router.route).toHaveBeenCalledWith('LIPSYNC', 'BUSINESS', {
      generationId: 'g1',
      only: 'paid:presenter',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(attempts.begin as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('resumes the exact submitted side-door job despite a later kill switch and records dynamic cost once', async () => {
    const fixture = runnerFor(row('LIPSYNC'), false);
    const paid = candidate('paid:presenter', async () => ({ providerKey: 'paid:presenter', artifacts: [] }));
    const attempts = journal(paid, true);
    const execute = vi.fn(async (opts: ProviderOpts) => {
      expect(opts.resume).toEqual({ providerJobId: 'paid-job-1', data: { pollUrl: 'https://vendor.test/jobs/1' } });
      return { url: 'https://vendor.test/result.mp4', seconds: 12 };
    });
    const call = (fixture.runner as unknown as { callExternal: CallExternal }).callExternal.bind(fixture.runner);

    await expect(
      call(
        attempts,
        paid.provider,
        'BUSINESS',
        externalInput,
        execute,
        { timeoutMs: 1_000, signal: new AbortController().signal, costMinor: (result) => result.seconds * 2 },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ),
    ).resolves.toMatchObject({ seconds: 12 });
    expect(fixture.router.route).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(attempts.settled).toHaveBeenCalledWith('attempt-1', 'SUCCEEDED', undefined, 24);
  });
});
