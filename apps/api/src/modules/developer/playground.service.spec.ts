import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCapabilityParams } from '@anystudio/shared';
import { FEATURE_KEYS, PlaygroundExhaustedError, PlaygroundService, dailyLimit } from './playground.service';

/**
 * Every playground run is real provider spend, so what is pinned is the
 * cap: it counts the day's rows in UTC, a run that would go over is refused
 * before any money moves, a replay of the same photo is free and uncounted,
 * the calls go through GenerationService with the playground's own
 * clientKeys (so the ledger and the stream treat them like any other), and a
 * photo from another workspace is not a photo.
 */

const actor = { userId: 'user-1' } as never;
let db: {
  mediaAsset: { findFirst: ReturnType<typeof vi.fn> };
  generation: { count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  creditCost: { findMany: ReturnType<typeof vi.fn> };
};
let generations: { request: ReturnType<typeof vi.fn> };
let service: PlaygroundService;

beforeEach(() => {
  db = {
    mediaAsset: { findFirst: vi.fn(async () => ({ id: 'asset-12345678-aaaa', key: 'ws/uploads/bag.jpg', status: 'READY' })) },
    generation: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    creditCost: {
      findMany: vi.fn(async () => [
        { code: 'image.inspect', credits: 1 },
        { code: 'text.description', credits: 2 },
        { code: 'image.background', credits: 10 },
        { code: 'image.product_shot', credits: 10 },
        { code: 'image.bg_remove', credits: 2 },
        { code: 'video.reel', credits: 120 },
        { code: 'video.ad_15s_presenter', credits: 400 },
      ]),
    },
  };
  generations = {
    request: vi.fn(async (r: { capability: string; clientKey: string }) => ({
      generation: { id: `gen-${r.capability}`, status: 'QUEUED', credits: 1 },
      balance: 137,
    })),
  };
  service = new PlaygroundService(db as never, generations as never);
  delete process.env.PLAYGROUND_DAILY_RUNS;
});
afterEach(() => {
  delete process.env.PLAYGROUND_DAILY_RUNS;
});

describe('the daily allowance', () => {
  it('is 15 unless the environment says otherwise, and ignores nonsense', () => {
    expect(dailyLimit({} as NodeJS.ProcessEnv)).toBe(15);
    expect(dailyLimit({ PLAYGROUND_DAILY_RUNS: '30' } as NodeJS.ProcessEnv)).toBe(30);
    expect(dailyLimit({ PLAYGROUND_DAILY_RUNS: '0' } as NodeJS.ProcessEnv)).toBe(15);
    expect(dailyLimit({ PLAYGROUND_DAILY_RUNS: 'lots' } as NodeJS.ProcessEnv)).toBe(15);
  });

  it('counts the playground rows since midnight UTC, and says when it resets', async () => {
    db.generation.count.mockResolvedValueOnce(9);
    const a = await service.allowance('ws', new Date('2026-09-15T22:30:00Z'));
    expect(db.generation.count).toHaveBeenCalledWith({
      where: { workspaceId: 'ws', clientKey: { startsWith: 'playground:' }, createdAt: { gte: new Date('2026-09-15T00:00:00.000Z') } },
    });
    expect(a).toEqual({ dailyLimit: 15, usedToday: 9, remaining: 6, resetsAt: '2026-09-16T00:00:00.000Z' });
  });
});

describe('the menu', () => {
  it('is priced from the credit table, and the product-alone shot is an edit that names the hand', async () => {
    const menu = await service.features();
    expect(menu.map((f) => [f.key, f.credits])).toEqual([
      ['check', 1],
      ['copy', 2],
      ['background', 10],
      ['product_alone', 10],
      ['cutout', 2],
      ['enhance', 10],
      ['reel', 120],
      ['ugc', 400],
    ]);
    await service.run(actor, 'ws', { assetId: 'asset-12345678-aaaa', features: ['product_alone', 'ugc'] });
    expect(generations.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'PRODUCT_SHOT', params: expect.objectContaining({ mode: 'edit', prompt: expect.stringContaining('hand') }) }),
    );
    expect(generations.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'IMAGE_TO_VIDEO',
        params: expect.objectContaining({ format: 'ugc', shots: 2, presenter: { kind: 'stock', key: 'daphne' } }),
      }),
    );
  });

  it('every feature builds parameters the capability schema accepts — with and without a title', async () => {
    for (const title of ['Mini handbag', null]) {
      generations.request.mockClear();
      await service.run(actor, 'ws', { assetId: 'asset-12345678-aaaa', features: [...FEATURE_KEYS], title, details: title ? '128 GB' : null });
      const calls = generations.request.mock.calls.map((c) => c[0] as { capability: never; params: Record<string, unknown> });
      expect(calls).toHaveLength(FEATURE_KEYS.length);
      for (const c of calls) {
        const parsed = parseCapabilityParams(c.capability, c.params);
        expect(parsed.ok, `${String(c.capability)} ${JSON.stringify(parsed)}`).toBe(true);
      }
    }
  });

  it('ignores a feature that is not on the menu rather than reaching past it', async () => {
    await service.run(actor, 'ws', { assetId: 'asset-12345678-aaaa', features: ['check', 'delete_everything' as never] });
    expect(generations.request).toHaveBeenCalledTimes(1);
  });
});

describe('a run', () => {
  it('starts each chosen call through GenerationService, keyed on the photo, and reports the allowance after', async () => {
    const out = await service.run(actor, 'ws', {
      assetId: 'asset-12345678-aaaa',
      features: ['check', 'copy'],
      title: 'Mini handbag',
      details: '128 GB, unlocked',
    });
    expect(generations.request).toHaveBeenCalledTimes(2);
    expect(generations.request).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws',
        requestedById: 'user-1',
        capability: 'INSPECT',
        params: { sourceKey: 'ws/uploads/bag.jpg', declared: { name: 'Mini handbag' } },
        clientKey: 'playground:asset-12:check:v1',
        channel: 'WEB',
      }),
    );
    expect(generations.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'TEXT_GENERATE',
        params: { sourceKey: 'ws/uploads/bag.jpg', productName: 'Mini handbag', details: '128 GB, unlocked', language: 'en' },
      }),
    );
    expect(out.runs.map((r) => r.feature)).toEqual(['check', 'copy']);
    expect(out.balance).toBe(137);
    expect(out.allowance.dailyLimit).toBe(15);
  });

  it('refuses before any money moves when the day is used up', async () => {
    db.generation.count.mockResolvedValue(14);
    await expect(service.run(actor, 'ws', { assetId: 'asset-12345678-aaaa', features: ['check', 'background'] })).rejects.toBeInstanceOf(
      PlaygroundExhaustedError,
    );
    expect(generations.request).not.toHaveBeenCalled();
    // one more fits exactly
    await service.run(actor, 'ws', { assetId: 'asset-12345678-aaaa', features: ['check'] });
    expect(generations.request).toHaveBeenCalledTimes(1);
  });

  it('does not count a replay of the same photo against the day', async () => {
    db.generation.count.mockResolvedValue(15);
    db.generation.findMany.mockResolvedValueOnce([{ clientKey: 'playground:asset-12:check:v1' }]);
    await service.run(actor, 'ws', { assetId: 'asset-12345678-aaaa', features: ['check'] });
    expect(generations.request).toHaveBeenCalledTimes(1); // GenerationService answers the existing row for free
  });

  it('says so with the allowance in the error, and a 429', async () => {
    db.generation.count.mockResolvedValue(15);
    const err = await service.run(actor, 'ws', { assetId: 'asset-12345678-aaaa', features: ['check'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaygroundExhaustedError);
    expect((err as PlaygroundExhaustedError).status).toBe(429);
    expect((err as PlaygroundExhaustedError).details).toMatchObject({ allowance: { remaining: 0 } });
    expect((err as PlaygroundExhaustedError).message).toContain('API keys are not limited');
  });

  it('does not run on a photo from another workspace', async () => {
    db.mediaAsset.findFirst.mockResolvedValueOnce(null);
    await expect(service.run(actor, 'ws', { assetId: 'asset-12345678-aaaa', features: ['check'] })).rejects.toMatchObject({ status: 404 });
    expect(db.mediaAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'asset-12345678-aaaa', workspaceId: 'ws' } }));
  });
});
