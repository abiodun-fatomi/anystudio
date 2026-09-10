import { describe, expect, it, vi } from 'vitest';
import { GenerationService, parentResumeCapability } from '../modules/generation/generation.service';
import { GenerationRunner } from './runner';

describe('parent resume queue isolation', () => {
  it('maps only video assembly onto the local queue capability', () => {
    expect(parentResumeCapability('IMAGE_TO_VIDEO')).toBe('VIDEO_STITCH');
    expect(parentResumeCapability('BATCH')).toBe('BATCH');
  });

  it('the last terminal child wakes its IMAGE_TO_VIDEO parent on media.local', async () => {
    const enqueue = vi.fn().mockResolvedValue({ queued: true, queue: 'media.local' });
    const runner = Object.assign(Object.create(GenerationRunner.prototype) as object, {
      db: {
        generation: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'child-1', status: 'SUCCEEDED' },
            { id: 'child-2', status: 'SUCCEEDED' },
          ]),
          findUnique: vi.fn().mockResolvedValue({ status: 'RUNNING', stage: 'waiting', capability: 'IMAGE_TO_VIDEO' }),
        },
      },
      events: { stage: vi.fn().mockResolvedValue(undefined) },
      queue: { enqueue },
    }) as GenerationRunner;

    await (runner as unknown as { wakeParent(parentId: string, childId: string, log: { info: (...args: unknown[]) => void }): Promise<void> }).wakeParent(
      'parent-1',
      'child-2',
      { info: vi.fn() },
    );

    expect(enqueue).toHaveBeenCalledWith('parent-1', 'VIDEO_STITCH');
  });

  it('the last terminal child wakes its BATCH parent on media.fast', async () => {
    const enqueue = vi.fn().mockResolvedValue({ queued: true, queue: 'media.fast' });
    const runner = Object.assign(Object.create(GenerationRunner.prototype) as object, {
      db: {
        generation: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'child-1', status: 'SUCCEEDED' },
            { id: 'child-2', status: 'FAILED' },
          ]),
          findUnique: vi.fn().mockResolvedValue({ status: 'RUNNING', stage: 'waiting', capability: 'BATCH' }),
        },
      },
      events: { stage: vi.fn().mockResolvedValue(undefined) },
      queue: { enqueue },
    }) as GenerationRunner;

    await (runner as unknown as { wakeParent(parentId: string, childId: string, log: { info: (...args: unknown[]) => void }): Promise<void> }).wakeParent(
      'batch-1',
      'child-2',
      { info: vi.fn() },
    );

    expect(enqueue).toHaveBeenCalledWith('batch-1', 'BATCH');
  });

  it('the recovery sweep also wakes ready parents on media.local', async () => {
    const enqueue = vi.fn().mockResolvedValue({ queued: true, queue: 'media.local' });
    const db = { generation: { findMany: vi.fn().mockResolvedValue([{ id: 'parent-2', capability: 'IMAGE_TO_VIDEO' }]) } };
    const service = new GenerationService(db as never, {} as never, {} as never, { enqueue } as never, {} as never);

    await expect(service.wakeReadyParents()).resolves.toEqual(['parent-2']);

    expect(enqueue).toHaveBeenCalledWith('parent-2', 'VIDEO_STITCH');
  });

  it('returns ready parents to the media database fallback when Redis rejects the enqueue', async () => {
    const enqueue = vi.fn().mockResolvedValue({ queued: false, queue: 'media.local', reason: 'redis unavailable' });
    const db = { generation: { findMany: vi.fn().mockResolvedValue([{ id: 'parent-3', capability: 'IMAGE_TO_VIDEO' }]) } };
    const service = new GenerationService(db as never, {} as never, {} as never, { enqueue } as never, {} as never);

    await expect(service.wakeReadyParents()).resolves.toEqual(['parent-3']);
    expect(enqueue).toHaveBeenCalledWith('parent-3', 'VIDEO_STITCH');
  });

  it('returns only ready parents whose resume work belongs to the caller queue role', async () => {
    const enqueue = vi.fn().mockResolvedValue({ queued: false, reason: 'redis unavailable' });
    const db = {
      generation: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'ad-parent', capability: 'IMAGE_TO_VIDEO' },
          { id: 'batch-parent', capability: 'BATCH' },
        ]),
      },
    };
    const service = new GenerationService(db as never, {} as never, {} as never, { enqueue } as never, {} as never);

    await expect(service.wakeReadyParents(['VIDEO_STITCH'])).resolves.toEqual(['ad-parent']);
    expect(enqueue).toHaveBeenLastCalledWith('ad-parent', 'VIDEO_STITCH');
    expect(db.generation.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ capability: { in: expect.arrayContaining(['IMAGE_TO_VIDEO']) } }) }),
    );
    enqueue.mockClear();

    await expect(service.wakeReadyParents(['BATCH', 'IMAGE_TO_VIDEO'])).resolves.toEqual(['batch-parent']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('batch-parent', 'BATCH');
    expect(db.generation.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ capability: { in: expect.arrayContaining(['BATCH']) } }) }),
    );
  });

  it('the stale sweep recognizes a complete BATCH and requeues its gather pass on media.fast', async () => {
    const staleAt = new Date(Date.now() - 60 * 60_000);
    const enqueue = vi.fn().mockResolvedValue({ queued: true, queue: 'media.fast' });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = {
      generation: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'batch-stale',
            status: 'RUNNING',
            kind: 'PARENT',
            capability: 'BATCH',
            attempts: 2,
            heartbeatAt: staleAt,
            createdAt: staleAt,
            stage: 'composing',
            input: { sourceKeys: ['one.jpg', 'two.jpg'] },
          },
        ]),
        count: vi.fn(async ({ where }: { where: { status?: unknown } }) => (where.status ? 0 : 2)),
        updateMany,
      },
    };
    const service = new GenerationService(db as never, {} as never, {} as never, { enqueue } as never, {} as never);

    await expect(service.sweepStale()).resolves.toEqual(['batch-stale']);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'batch-stale', status: 'RUNNING' }),
        data: expect.objectContaining({ stage: 'waiting' }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith('batch-stale', 'BATCH');
  });
});
