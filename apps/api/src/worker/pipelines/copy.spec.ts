import { describe, expect, it, vi } from 'vitest';
import type { CopyOutput } from '@anystudio/shared';
import { copyPipeline } from './copy';
import type { PipelineContext } from './index';
import { minhash } from './uniqueness';

const written: CopyOutput = {
  description: {
    long: 'A durable everyday carry bag with roomy storage and a clean shape for work, errands, and weekends.',
    short: 'A roomy everyday bag with a clean, durable finish.',
    bullets: ['Roomy everyday storage', 'Clean versatile shape'],
    specs: [],
  },
  captions: { instagram: 'One bag for work, errands, and weekends.' },
  hashtags: { broad: [], niche: [], local: [] },
  altText: 'A clean everyday carry bag shown from the front.',
  seo: { title: 'Durable Everyday Carry Bag', metaDescription: 'A roomy everyday bag for work, errands, and weekends.', keywords: [] },
};

describe('copy fallback cancellation', () => {
  it('does not ship the first paid answer when duplicate regeneration was aborted', async () => {
    const aborted = Object.assign(new Error('copy regeneration aborted'), { name: 'AbortError' });
    const callProvider = vi
      .fn()
      .mockResolvedValueOnce({ providerKey: 'openai:text', providerJobId: 'first', artifacts: [{ role: 'text', mime: 'application/json', text: written }] })
      .mockRejectedValueOnce(aborted);
    const create = vi.fn(async () => ({}));
    const ctx = {
      row: {
        id: 'copy-1',
        workspaceId: 'ws-1',
        capability: 'TEXT_GENERATE',
        input: { task: 'product_copy', language: 'en', platforms: ['instagram'], productKey: 'current-product' },
      },
      workspace: { region: 'ng', currency: 'NGN', profile: null },
      brandKit: null,
      files: {},
      signal: new AbortController().signal,
      budgetMs: 60_000,
      callProvider,
      stage: vi.fn(async () => undefined),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      db: {
        copyFingerprint: {
          findMany: vi.fn(async () => [{ generationId: 'older-copy', minhash: minhash(written.description.long) }]),
          create,
        },
        generation: {
          findUnique: vi.fn(async () => ({ outputs: [{ role: 'text', text: written }] })),
        },
      },
    } as unknown as PipelineContext;

    await expect(copyPipeline(ctx)).rejects.toBe(aborted);
    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
  });
});
