/**
 * The one path in the studio a seller can be promised.
 *
 * A cut-out onto a flat colour touches no generative model, so given the same
 * photo it should give the same picture — and, crucially, the same picture
 * whichever vendor happened to answer. That was not true: the colour was left
 * to each adapter, Photoroom and Replicate honoured it, and
 * `fal-ai/bria/background/remove` has no such parameter at all, so an
 * ORGANIZATION workspace (where fal is first in the routing order) got a
 * transparent PNG for "Plain white" and nothing downstream noticed.
 *
 * These tests hold the promise where it now lives: in the pipeline, once, for
 * every vendor.
 */
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { backgroundRemovePipeline } from './background-remove';
import { Pipelines, type PipelineContext } from './index';

const SIZE = 64;

/** What a matting vendor returns: a product, and nothing at all behind it. */
async function cutout(): Promise<Uint8Array> {
  const block = await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 1 } } })
    .png()
    .toBuffer();
  const out = await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: block, top: 20, left: 20 }])
    .png()
    .toBuffer();
  return new Uint8Array(out);
}

/** What Photoroom returns: the same product, already flattened onto the colour. */
async function alreadyPainted(hex: { r: number; g: number; b: number }): Promise<Uint8Array> {
  const block = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 200, g: 30, b: 40 } } })
    .png()
    .toBuffer();
  const out = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: hex } })
    .composite([{ input: block, top: 20, left: 20 }])
    .png()
    .toBuffer();
  return new Uint8Array(out);
}

/** The colour at a corner — the part of the frame that is only ever background. */
async function corner(image: Uint8Array) {
  const raw = await sharp(image).extract({ left: 0, top: 0, width: 8, height: 8 }).raw().toBuffer({ resolveWithObject: true });
  return { r: raw.data[0]!, g: raw.data[1]!, b: raw.data[2]!, channels: raw.info.channels };
}

function ctxWith(vendorOutput: Uint8Array, background: string, providerKey = 'fal:bria-rmbg-2') {
  const callProvider = vi.fn(async () => ({
    providerKey,
    providerJobId: 'j-1',
    costMinor: 2,
    artifacts: [
      { role: 'image', mime: 'image/png', bytes: vendorOutput },
      { role: 'mask', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
    ],
  }));
  const ctx = {
    row: { id: 'g-1', workspaceId: 'ws-1', capability: 'BACKGROUND_REMOVE', input: { sourceKey: 'ws-1/p.png', background } },
    files: { sourceKey: { key: 'ws-1/p.png', url: 'https://signed/p.png', mime: 'image/png' } },
    callProvider,
    stage: vi.fn(async () => undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
    budgetMs: 60_000,
  } as unknown as PipelineContext;
  return { ctx, callProvider };
}

/**
 * The wiring, asserted separately from the behaviour.
 *
 * Every test below calls `backgroundRemovePipeline` directly, so all of them
 * stay green if the capability is never routed to it — which is precisely how
 * this fix could be undone without anything going red. `Pipelines.run` falls
 * back to `passthrough` for any capability it does not know, silently, and
 * that fallback is what the original bug was made of.
 */
it('routes BACKGROUND_REMOVE here rather than falling back to passthrough', async () => {
  const painted = vi.fn(async () => ({ providerKey: 'x', artifacts: [{ role: 'image', mime: 'image/png', bytes: await cutout() }], costMinor: 1 }));
  const ctx = {
    row: { id: 'g-1', workspaceId: 'ws-1', capability: 'BACKGROUND_REMOVE', kind: 'SINGLE', input: { sourceKey: 'ws-1/p.png', background: '#ffffff' } },
    files: { sourceKey: { key: 'ws-1/p.png', url: 'https://signed/p.png', mime: 'image/png' } },
    callProvider: painted,
    stage: vi.fn(async () => undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
    budgetMs: 60_000,
  } as unknown as PipelineContext;
  const out = await new Pipelines().run(ctx);
  // passthrough would hand back the vendor's transparent PNG untouched.
  const c = await corner(out.artifacts[0]!.bytes!);
  expect(c.r).toBeGreaterThan(250);
  expect(c.channels).toBe(3);
});

describe('cutting a product out onto a colour', () => {
  it('paints the colour even when the vendor ignored it', async () => {
    // This is the bug, exactly: bria returns transparency and is asked for white.
    const { ctx } = ctxWith(await cutout(), '#ffffff');
    const out = await backgroundRemovePipeline(ctx);
    const c = await corner(out.artifacts[0]!.bytes!);
    expect(c.r).toBeGreaterThan(250);
    expect(c.g).toBeGreaterThan(250);
    expect(c.b).toBeGreaterThan(250);
  });

  it('paints any colour the seller picked, not just white', async () => {
    const { ctx } = ctxWith(await cutout(), '#101014');
    const c = await corner((await backgroundRemovePipeline(ctx)).artifacts[0]!.bytes!);
    expect(c.r).toBeLessThan(30);
    expect(c.g).toBeLessThan(30);
    expect(c.b).toBeLessThan(35);
  });

  it('leaves a vendor that already painted it exactly as it was', async () => {
    // `flatten` on an image with no alpha is a no-op. That is what makes this
    // safe to run for every vendor rather than only the one that needs it —
    // Photoroom must not be double-painted or shifted.
    const painted = await alreadyPainted({ r: 246, g: 241, b: 234 });
    const { ctx } = ctxWith(painted, '#f6f1ea', 'photoroom:edit');
    const out = await backgroundRemovePipeline(ctx);
    const c = await corner(out.artifacts[0]!.bytes!);
    expect(c.r).toBeGreaterThan(240);
    expect(c.g).toBeGreaterThan(235);
    expect(c.b).toBeGreaterThan(228);
  });

  it('keeps the product itself untouched while repainting behind it', async () => {
    const { ctx } = ctxWith(await cutout(), '#ffffff');
    const out = await backgroundRemovePipeline(ctx);
    const raw = await sharp(out.artifacts[0]!.bytes!).extract({ left: 28, top: 28, width: 8, height: 8 }).raw().toBuffer();
    expect(raw[0]).toBeGreaterThan(180);
    expect(raw[2]).toBeLessThan(80);
  });

  it('returns the transparent PNG untouched when no background was asked for', async () => {
    // Painting anything here would destroy the entire point of the cut-out.
    const cut = await cutout();
    const { ctx } = ctxWith(cut, 'transparent');
    const out = await backgroundRemovePipeline(ctx);
    expect(out.artifacts[0]!.bytes).toBe(cut);
    const c = await corner(out.artifacts[0]!.bytes!);
    expect(c.channels).toBe(4);
  });

  it('carries the vendor identity and cost through, so the attempt journal still balances', async () => {
    const { ctx, callProvider } = ctxWith(await cutout(), '#ffffff');
    const out = await backgroundRemovePipeline(ctx);
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(out.providerKey).toBe('fal:bria-rmbg-2');
    expect(out.providerJobId).toBe('j-1');
    expect(out.costMinor).toBe(2);
  });

  it('keeps a mask or preview the vendor sent alongside the picture', async () => {
    const { ctx } = ctxWith(await cutout(), '#ffffff');
    const out = await backgroundRemovePipeline(ctx);
    expect(out.artifacts.map((a) => a.role)).toEqual(['image', 'mask']);
  });

  it('fails rather than shipping transparency to somebody who asked for a colour', async () => {
    // The vendor was paid and the cut-out exists; only our paint step failed.
    // Returning the unpainted PNG would be the original bug wearing a hat.
    const { ctx } = ctxWith(new Uint8Array([0, 1, 2, 3]), '#ffffff');
    await expect(backgroundRemovePipeline(ctx)).rejects.toThrow(/background/i);
  });
});
