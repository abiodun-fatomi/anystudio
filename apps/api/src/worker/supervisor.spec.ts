import { describe, expect, it, vi } from 'vitest';
import { heartbeatIsFresh } from './healthcheck';
import {
  WorkerSupervisor,
  capabilitiesForQueues,
  runsGlobalSchedulers,
  runWithSchedulerLock,
  workerConfigurationError,
  workerHeartbeatKey,
} from './supervisor';

describe('worker service roles', () => {
  it('runs global schedulers on the main worker only', () => {
    expect(runsGlobalSchedulers('worker')).toBe(true);
    expect(runsGlobalSchedulers('media')).toBe(false);
  });

  it('keeps main and media liveness in distinct Redis keys', () => {
    expect(workerHeartbeatKey('worker', 'host-a')).toBe('worker:heartbeat:worker:host-a');
    expect(workerHeartbeatKey('media', 'host-a')).toBe('worker:heartbeat:media:host-a');
    expect(workerHeartbeatKey('worker', 'host-a')).not.toBe(workerHeartbeatKey('media', 'host-a'));
    expect(workerHeartbeatKey('worker', 'host-a')).not.toBe(workerHeartbeatKey('worker', 'host-b'));
  });

  it('keeps Redis-down database claims inside each service queue boundary', () => {
    const main = capabilitiesForQueues(['media.fast', 'media.heavy']);
    const media = capabilitiesForQueues(['media.local']);

    expect(main).toContain('IMAGE_TO_VIDEO');
    expect(main).not.toContain('VIDEO_STITCH');
    expect(main).not.toContain('COLLAGE');
    expect(media).toEqual(expect.arrayContaining(['VIDEO_STITCH', 'COLLAGE']));
    expect(media).not.toContain('IMAGE_TO_VIDEO');
  });

  it('uses that same boundary when directly claiming ready parent resumes', async () => {
    const run = async (directCapabilities: ReturnType<typeof capabilitiesForQueues>, readyIds: string[]) => {
      const runner = { run: vi.fn(async () => 'succeeded') };
      const generations = { wakeReadyParents: vi.fn(async () => readyIds) };
      const findMany = vi.fn(async () => []);
      const supervisor = Object.assign(Object.create(WorkerSupervisor.prototype) as object, {
        directBusy: 0,
        directCapabilities,
        db: { generation: { findMany } },
        generations,
        runner,
      }) as WorkerSupervisor;

      await (supervisor as unknown as { runDirect(): Promise<void> }).runDirect();
      await Promise.resolve();
      return { findMany, generations, runner };
    };

    const mainCapabilities = capabilitiesForQueues(['media.fast', 'media.heavy']);
    const mediaCapabilities = capabilitiesForQueues(['media.local']);
    const main = await run(mainCapabilities, ['batch-parent']);
    const media = await run(mediaCapabilities, ['ad-parent']);

    expect(main.generations.wakeReadyParents).toHaveBeenCalledWith(mainCapabilities);
    expect(main.runner.run).toHaveBeenCalledWith('batch-parent');
    expect(media.generations.wakeReadyParents).toHaveBeenCalledWith(mediaCapabilities);
    expect(media.runner.run).toHaveBeenCalledWith('ad-parent');
  });

  it('accepts only a fresh per-service database heartbeat', () => {
    const now = Date.parse('2026-09-08T00:00:00.000Z');
    expect(heartbeatIsFresh(new Date(now - 89_999), now)).toBe(true);
    expect(heartbeatIsFresh(new Date(now - 90_000), now)).toBe(false);
    expect(heartbeatIsFresh(null, now)).toBe(false);
  });

  it('fails closed when a production role would serve the wrong queues', () => {
    expect(workerConfigurationError('worker', ['media.fast', 'media.heavy'])).toBeNull();
    expect(workerConfigurationError('worker', ['media.heavy', 'media.fast'])).toBeNull();
    expect(workerConfigurationError('media', ['media.local'])).toBeNull();
    expect(workerConfigurationError('worker', [])).toContain('(unset)');
    expect(workerConfigurationError('worker', ['media.fast', 'media.heavy', 'media.local'])).toContain('worker must set');
    expect(workerConfigurationError('media', ['media.heavy', 'media.local'])).toContain('media must set');
    expect(workerConfigurationError('typo', ['media.local'])).toContain('SERVICE_NAME');
  });

  it('runs a scheduler pass only while its cross-process advisory lock is held', async () => {
    const task = vi.fn(async () => undefined);
    const lockedDb = {
      $transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({ $queryRaw: vi.fn(async () => [{ acquired: false }]) })),
    };
    const leaderDb = {
      $transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({ $queryRaw: vi.fn(async () => [{ acquired: true }]) })),
    };

    expect(await runWithSchedulerLock(lockedDb as never, 'webhooks', task)).toBe(false);
    expect(task).not.toHaveBeenCalled();
    expect(await runWithSchedulerLock(leaderDb as never, 'webhooks', task)).toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
