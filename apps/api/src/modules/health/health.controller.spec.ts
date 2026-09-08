import { describe, expect, it, vi } from 'vitest';
import { HealthController, workerProbe } from './health.controller';

describe('release readiness', () => {
  const billing = (ready = true) => ({ check: vi.fn().mockResolvedValue({ ready, missing: ready ? [] : ['internal detail'] }) });

  it('reports only freshness and the short release for a worker', () => {
    const now = Date.parse('2026-09-08T00:00:00.000Z');
    expect(workerProbe({ seenAt: new Date(now - 10_000), version: 'abcdef0123456789' }, now)).toEqual({ alive: true, release: 'abcdef0' });
    expect(workerProbe({ seenAt: new Date(now - 90_000), version: null }, now)).toEqual({ alive: false, release: null });
  });

  it('is ready only when both distinct worker services checked in', async () => {
    const now = Date.now();
    const findFirst = vi
      .fn()
      .mockImplementation(({ where }: { where: { service: string } }) =>
        Promise.resolve(where.service === 'worker' ? { seenAt: new Date(now), version: 'abcdef012345' } : { seenAt: new Date(now), version: 'abcdef012345' }),
      );
    const controller = new HealthController({ $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]), workerHeartbeat: { findFirst } } as never, billing() as never);
    const response = { status: vi.fn() };

    await expect(controller.ready(response as never)).resolves.toMatchObject({
      status: 'ready',
      workers: { worker: { alive: true, release: 'abcdef0' }, media: { alive: true, release: 'abcdef0' } },
      billing: { ready: true },
    });
    expect(response.status).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('returns 503 when the dedicated media worker is missing', async () => {
    const findFirst = vi.fn().mockResolvedValueOnce({ seenAt: new Date(), version: 'abcdef012345' }).mockResolvedValueOnce(null);
    const controller = new HealthController({ $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]), workerHeartbeat: { findFirst } } as never, billing() as never);
    const response = { status: vi.fn() };

    await expect(controller.ready(response as never)).resolves.toMatchObject({ status: 'degraded', workers: { media: { alive: false, release: null } } });
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it('returns 503 for an incomplete payment catalogue without exposing its details', async () => {
    const heartbeat = { seenAt: new Date(), version: 'abcdef012345' };
    const controller = new HealthController(
      { $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]), workerHeartbeat: { findFirst: vi.fn().mockResolvedValue(heartbeat) } } as never,
      billing(false) as never,
    );
    const response = { status: vi.fn() };

    const result = await controller.ready(response as never);

    expect(result).toMatchObject({ status: 'degraded', billing: { ready: false } });
    expect(JSON.stringify(result)).not.toContain('internal detail');
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
