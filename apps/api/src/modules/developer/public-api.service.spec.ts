import { describe, expect, it, vi } from 'vitest';
import type { ApiKey } from '@prisma/client';
import { API_SCENARIOS, PUBLIC_CAPABILITIES, PRODUCT_MODES, PIPELINE_WRITTEN_KEYS, parseCapabilityParams } from '@anystudio/shared';
import { PublicApiService } from './public-api.service';
import { PublicApiController } from './public-api.controller';
import { API_SCOPE_KEY } from './api-key.guard';
import { GenerationService } from '../generation/generation.service';

const key = { id: 'key', workspaceId: 'workspace', projectId: 'project', createdById: 'user' } as ApiKey;
function fixture() {
  const db = { creditCost: { findMany: vi.fn().mockResolvedValue([]) }, generation: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) } };
  const generations = { quote: vi.fn().mockResolvedValue({ credits: 2 }), request: vi.fn(), cancel: vi.fn() };
  const api = new PublicApiService(db as never, generations as never, {} as never, {} as never, {} as never);
  return { api, db, generations };
}

describe('public API documentation contract', () => {
  it('replays its own accepted request before checking purged sources or current daily quota', async () => {
    const row = { id: 'existing', workspaceId: 'workspace', projectId: 'project', channel: 'API', kind: 'SINGLE', deletedAt: null };
    const db = {
      generation: { findUnique: vi.fn().mockResolvedValue(row), count: vi.fn() },
      wallet: { findUnique: vi.fn().mockResolvedValue({ id: 'wallet' }) },
    };
    const media = { requireReady: vi.fn().mockRejectedValue(new Error('source purged')) };
    const service = new GenerationService(db as never, { balance: vi.fn().mockResolvedValue(98) } as never, media as never, {} as never, {} as never);
    await expect(
      service.request({
        workspaceId: 'workspace',
        requestedById: 'user',
        projectId: 'project',
        channel: 'API',
        clientKey: 'retry',
        capability: 'IMAGE_TO_VIDEO',
        params: { sourceKey: 'workspace/uploads/purged.jpg', shots: 1 },
      }),
    ).resolves.toMatchObject({ generation: { id: 'existing' }, balance: 98 });
    expect(media.requireReady).not.toHaveBeenCalled();
    expect(db.generation.count).not.toHaveBeenCalled();
  });
  it.each(API_SCENARIOS)('$id has a valid body and no silently stripped fields', (scenario) => {
    const result = parseCapabilityParams(scenario.body.capability, scenario.body.params);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.params).toMatchObject(scenario.body.params);
    expect(scenario.body.clientKey).toMatch(/^[A-Za-z0-9_\-:.]{1,80}$/);
  });
  it('covers every public capability and product mode exactly where needed', () => {
    expect([...new Set(API_SCENARIOS.map((s) => s.body.capability))].sort()).toEqual([...PUBLIC_CAPABILITIES].sort());
    expect(
      API_SCENARIOS.filter((s) => s.body.capability === 'PRODUCT_SHOT')
        .map((s) => s.body.params.mode)
        .sort(),
    ).toEqual(Object.keys(PRODUCT_MODES).sort());
    expect(new Set(API_SCENARIOS.map((s) => s.id)).size).toBe(API_SCENARIOS.length);
  });
  it('discovery excludes internal capability/fields and preserves numeric choices', async () => {
    const { api } = fixture();
    const catalogue = await api.capabilities();
    expect(catalogue.map((c) => c.capability)).not.toContain('VIDEO_STITCH');
    for (const entry of catalogue) {
      expect(entry.examples.length).toBeGreaterThan(0);
      expect(entry.params.some((p) => PIPELINE_WRITTEN_KEYS.includes(p.name) || p.name === 'negativePrompt')).toBe(false);
    }
    expect(catalogue.find((c) => c.capability === 'UPSCALE')?.params.find((p) => p.name === 'factor')).toMatchObject({ type: 'number', values: [2, 4] });
  });
  it('quotes validated full params, but never calls generation creation', async () => {
    const { api, generations } = fixture();
    await expect(api.quote(key, { capability: 'TEXT_GENERATE', params: { productName: 'Tote' } })).resolves.toEqual({ credits: 2 });
    expect(generations.quote).toHaveBeenCalledWith('workspace', 'TEXT_GENERATE', expect.objectContaining({ productName: 'Tote' }));
    await expect(api.quote(key, { capability: 'IMAGE_EDIT', params: {} })).rejects.toMatchObject({ status: 400 });
    expect(generations.request).not.toHaveBeenCalled();
  });
  it('rejects internal create and quote even outside DTO validation', async () => {
    const { api, generations } = fixture();
    for (const method of ['create', 'quote'] as const) {
      await expect(api[method](key, { capability: 'VIDEO_STITCH', params: {} })).rejects.toMatchObject({ status: 400 });
    }
    expect(generations.request).not.toHaveBeenCalled();
    expect(generations.quote).not.toHaveBeenCalled();
  });
  it.each([{ projectId: 'sibling' }, { workspaceId: 'other' }, { channel: 'WEB' }, { kind: 'CHILD' }, { deletedAt: new Date() }])(
    'hides non-public generations: %j',
    async (override) => {
      const { api, db } = fixture();
      db.generation.findUnique.mockResolvedValue({
        workspaceId: 'workspace',
        projectId: 'project',
        channel: 'API',
        kind: 'SINGLE',
        deletedAt: null,
        ...override,
      });
      await expect(api.own(key, 'id')).rejects.toMatchObject({ status: 404 });
    },
  );
  it('checks project ownership before song unlock and exposes read-only quote scopes', async () => {
    const api = { own: vi.fn().mockRejectedValue(new Error('not found')) };
    const audio = { unlock: vi.fn() };
    const controller = new PublicApiController(api as never, audio as never, {} as never);
    await expect(controller.unlock({ apiKey: key } as never, 'song')).rejects.toThrow('not found');
    expect(audio.unlock).not.toHaveBeenCalled();
    expect(Reflect.getMetadata(API_SCOPE_KEY, PublicApiController.prototype.quote)).toBe('catalogue:read');
    expect(Reflect.getMetadata(API_SCOPE_KEY, PublicApiController.prototype.unlockPrice)).toBe('catalogue:read');
  });
});

/**
 * POST /inspect is an INSPECT generation with a wait bolted on. What is
 * pinned: it is the same row and debit path as everything else (channel API,
 * the key's project, the merchant ref), and the three answers a caller can
 * get are told apart by status and by `inspection`, never by reading prose.
 */
describe('POST /inspect', () => {
  const verdict = {
    verdict: 'not_a_product',
    confidence: 0.94,
    saw: 'a screenshot of a chat',
    issues: ['screenshot'],
    advice: 'Take a photo of the item itself.',
  };
  const done = (generationId: string, status: string) => ({ type: 'done' as const, generationId, status, at: 'now' });
  const stage = (generationId: string) => ({ type: 'stage' as const, generationId, stage: 'generating', progress: 40, at: 'now' });

  function harness(over: { finalStatus?: string; events?: unknown[]; outputs?: unknown[]; watchNeverEnds?: boolean } = {}) {
    const created = { id: 'gen-1', status: 'QUEUED', workspaceId: 'workspace', projectId: 'project', channel: 'API', outputs: [] };
    const finalRow = { ...created, status: over.finalStatus ?? 'SUCCEEDED', outputs: over.outputs ?? [{ role: 'text', text: verdict }] };
    const generations = { request: vi.fn().mockResolvedValue({ generation: created, balance: 41 }) };
    const db = { generation: { findUnique: vi.fn().mockResolvedValue(finalRow) } };
    const webhooks = { generationPayload: vi.fn(async (row: { id: string; status: string }) => ({ id: row.id, status: row.status })) };
    const events = {
      watch: vi.fn(async function* (id: string, signal: AbortSignal) {
        if (over.watchNeverEnds) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          return;
        }
        for (const e of over.events ?? [stage(id), done(id, over.finalStatus ?? 'SUCCEEDED')]) yield e;
      }),
    };
    const api = new PublicApiService(db as never, generations as never, {} as never, {} as never, webhooks as never, events as never);
    return { api, generations, db, webhooks, events };
  }

  it('answers 200 with the verdict inline once the row finishes', async () => {
    const h = harness();
    const out = await h.api.inspect(key, { sourceKey: 'workspace/uploads/p.jpg', declared: { category: 'bags' }, merchantRef: 'store-441' });
    expect(out.status).toBe(200);
    expect(out.body.inspection).toMatchObject({ verdict: 'not_a_product', issues: ['screenshot'] });
    expect(out.body.balance).toBe(41);
    expect(out.body.generation).toEqual({ id: 'gen-1', status: 'SUCCEEDED' });
  });

  it('is the ordinary INSPECT generation underneath — same project, same channel, same merchant', async () => {
    const h = harness();
    await h.api.inspect(key, { sourceKey: 'workspace/uploads/p.jpg', declared: { name: 'Tote' }, merchantRef: 'store-441', clientKey: 'shop:9:check:v1' });
    expect(h.generations.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'INSPECT',
        params: { sourceKey: 'workspace/uploads/p.jpg', declared: { name: 'Tote' } },
        channel: 'API',
        projectId: 'project',
        apiKeyId: 'key',
        merchantRef: 'store-441',
        clientKey: 'shop:9:check:v1',
      }),
    );
  });

  it('mints a clientKey when the caller sends none, so a retry is not a second charge by accident', async () => {
    const h = harness();
    await h.api.inspect(key, { sourceKey: 'workspace/uploads/p.jpg' });
    expect(h.generations.request.mock.calls[0]![0].clientKey).toMatch(/^api:[0-9a-f-]{36}$/);
  });

  it('answers 200 with inspection null when the check failed — the credit is already back', async () => {
    const h = harness({ finalStatus: 'FAILED', outputs: [] });
    const out = await h.api.inspect(key, { sourceKey: 'workspace/uploads/p.jpg' });
    expect(out.status).toBe(200);
    expect(out.body.inspection).toBeNull();
    expect(out.body.generation.status).toBe('FAILED');
  });

  it('answers 202 with the row when the queue is slower than the wait, and stops waiting', async () => {
    const h = harness({ watchNeverEnds: true });
    const t0 = Date.now();
    const out = await h.api.inspect(key, { sourceKey: 'workspace/uploads/p.jpg' }, 30);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(out.status).toBe(202);
    expect(out.body.inspection).toBeNull();
    expect(out.body.generation.status).toBe('QUEUED');
    // Nothing was re-read: the row we already hold is the answer.
    expect(h.db.generation.findUnique).not.toHaveBeenCalled();
  });

  it('does not hand back a verdict it cannot vouch for', async () => {
    const h = harness({ outputs: [{ role: 'text', text: { verdict: 'maybe' } }] });
    const out = await h.api.inspect(key, { sourceKey: 'workspace/uploads/p.jpg' });
    expect(out.status).toBe(200);
    expect(out.body.inspection).toBeNull();
    expect(out.body.generation.status).toBe('SUCCEEDED');
  });

  it('skips the wait entirely for a replayed clientKey that already finished', async () => {
    const h = harness();
    h.generations.request.mockResolvedValueOnce({ generation: { id: 'gen-1', status: 'SUCCEEDED', outputs: [{ role: 'text', text: verdict }] }, balance: 41 });
    const out = await h.api.inspect(key, { sourceKey: 'workspace/uploads/p.jpg', clientKey: 'again' });
    expect(out.status).toBe(200);
    expect(out.body.inspection).toMatchObject({ verdict: 'not_a_product' });
    expect(h.events.watch).not.toHaveBeenCalled();
  });
});
