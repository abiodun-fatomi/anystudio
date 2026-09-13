import { describe, expect, it, vi } from 'vitest';
import { ProviderError, type InspectOutput } from '@anystudio/shared';
import { inspectPipeline } from './inspect';
import type { PipelineContext } from './index';

/**
 * What a platform is promised: a verdict from the closed list, reasons from
 * the closed list, the declaration echoed back, and a resolution flag that
 * comes from the file rather than from the model's imagination. And that a
 * model which answers off-structure is asked again, then refunded — never
 * shipped.
 */

const said = {
  verdict: 'mismatch',
  confidence: 0.91,
  saw: 'a pair of brown leather sandals on a tiled floor',
  issues: ['category_mismatch'],
  advice: 'Take a photo of the bag itself on a plain surface, in daylight.',
};

function ctx(over: {
  answers?: unknown[];
  asset?: { width: number | null; height: number | null } | null;
  mime?: string;
  declared?: { name?: string; category?: string };
}) {
  const answers = over.answers ?? [said];
  const callCapability = vi.fn();
  for (const a of answers)
    callCapability.mockResolvedValueOnce({
      providerKey: 'google:vision',
      providerJobId: 'j1',
      artifacts: [{ role: 'text', mime: 'application/json', text: a }],
    });
  const findUnique = vi.fn(async () => (over.asset === undefined ? { width: 1600, height: 1200 } : over.asset));
  return {
    callCapability,
    findUnique,
    ctx: {
      row: {
        id: 'gen-1',
        workspaceId: 'ws-1',
        capability: 'INSPECT',
        input: { sourceKey: 'ws-1/uploads/p.jpg', ...(over.declared ? { declared: over.declared } : {}) },
      },
      workspace: { region: 'ng', currency: 'NGN', profile: null },
      brandKit: null,
      files: { sourceKey: { key: 'ws-1/uploads/p.jpg', url: 'https://signed/p.jpg', mime: over.mime ?? 'image/jpeg' } },
      signal: new AbortController().signal,
      budgetMs: 30_000,
      callCapability,
      stage: vi.fn(async () => undefined),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      db: { mediaAsset: { findUnique } },
    } as unknown as PipelineContext,
  };
}

const verdictOf = (r: Awaited<ReturnType<typeof inspectPipeline>>) => r.artifacts[0]!.text as InspectOutput;

describe('inspect pipeline', () => {
  it('returns the verdict with the declaration echoed, through the text route', async () => {
    const t = ctx({ declared: { name: 'Mini handbag', category: 'bags' } });
    const out = verdictOf(await inspectPipeline(t.ctx));
    expect(out).toMatchObject({ verdict: 'mismatch', confidence: 0.91, issues: ['category_mismatch'], declared: { name: 'Mini handbag', category: 'bags' } });
    // Routed as a text question, not as a capability a vendor must declare.
    expect(t.callCapability).toHaveBeenCalledTimes(1);
    expect(t.callCapability.mock.calls[0]![0]).toBe('TEXT_GENERATE');
  });

  it('shows the model the picture and tells it what was declared', async () => {
    const t = ctx({ declared: { name: 'Mini handbag', category: 'bags' } });
    await inspectPipeline(t.ctx);
    const prompt = t.callCapability.mock.calls[0]![1].prompt;
    expect(prompt.parts[0]).toEqual({ imageUrl: 'https://signed/p.jpg', mime: 'image/jpeg' });
    expect(prompt.parts[1].text).toContain('name: "Mini handbag"');
    expect(prompt.parts[1].text).toContain('category: "bags"');
    expect(prompt.jsonSchema).toBeDefined();
  });

  it('judges only "is it a product" when nothing was declared', async () => {
    const t = ctx({});
    const out = verdictOf(await inspectPipeline(t.ctx));
    expect(out.declared).toBeUndefined();
    expect(t.callCapability.mock.calls[0]![1].prompt.parts[1].text).toContain('declared nothing');
  });

  it('adds low_resolution from the file itself, not from the model', async () => {
    const t = ctx({ asset: { width: 480, height: 360 } });
    const out = verdictOf(await inspectPipeline(t.ctx));
    expect(out.issues).toEqual(['category_mismatch', 'low_resolution']);
    // The model was never offered the code, so it could not have said it.
    const schema = t.callCapability.mock.calls[0]![1].prompt.jsonSchema as { properties: { issues: { items: { enum: string[] } } } };
    expect(schema.properties.issues.items.enum).not.toContain('low_resolution');
  });

  it('leaves resolution alone when the file is big enough or its size is unknown', async () => {
    expect(verdictOf(await inspectPipeline(ctx({ asset: { width: 1200, height: 900 } }).ctx)).issues).toEqual(['category_mismatch']);
    expect(verdictOf(await inspectPipeline(ctx({ asset: null }).ctx)).issues).toEqual(['category_mismatch']);
  });

  it('asks again with the errors quoted when the answer is off-structure, then ships the second', async () => {
    const t = ctx({ answers: [{ verdict: 'maybe', saw: 'x' }, said] });
    const out = verdictOf(await inspectPipeline(t.ctx));
    expect(out.verdict).toBe('mismatch');
    expect(t.callCapability).toHaveBeenCalledTimes(2);
    const second = t.callCapability.mock.calls[1]![1].prompt.parts.at(-1).text as string;
    expect(second).toContain('did not fit the required structure');
    expect(second).toContain('verdict');
  });

  it('fails the generation rather than shipping half a verdict after two misses', async () => {
    const t = ctx({ answers: [{ verdict: 'maybe' }, { nonsense: true }] });
    await expect(inspectPipeline(t.ctx)).rejects.toMatchObject({ kind: 'RETRYABLE' });
    expect(t.callCapability).toHaveBeenCalledTimes(2);
  });

  it('refuses a source that is not an image before spending anything', async () => {
    const t = ctx({ mime: 'video/mp4' });
    await expect(inspectPipeline(t.ctx)).rejects.toBeInstanceOf(ProviderError);
    await expect(inspectPipeline(t.ctx)).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(t.callCapability).not.toHaveBeenCalled();
  });

  it('never asks the model about age', async () => {
    const t = ctx({});
    await inspectPipeline(t.ctx);
    const system = t.callCapability.mock.calls[0]![1].prompt.system as string;
    expect(system).toContain('Never guess anyone’s age');
  });
});
