/**
 * The fidelity loop's DECISION, which until now was the only untested part
 * of it.
 *
 * `fidelity()` has its own tests and they are good: given a source, a mask
 * and an output it returns an honest number. What was never tested is what
 * the pipeline then DOES with that number — and that is where a seller's
 * picture is actually won or lost.
 *
 * The case that matters is the one a merchant reported: one background
 * chosen, and a bottle that came back with somebody else's bottom half. It
 * is not the model misbehaving in a new way. The model did the ordinary
 * thing — it kept the frame's shape and moved the product across it — and
 * the pipeline then laid the original product back at the coordinates it
 * had in the SOURCE, leaving the model's redrawn version of it still in the
 * picture a little to one side. Two products, overlapping, one of them
 * wrong. That reads as a deformed product, which is exactly what was
 * reported.
 *
 * So: same frame shape is not the same framing, and these tests hold that
 * line.
 */
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { brandedImagePipeline } from './image';
import type { PipelineContext } from './index';

const SIZE = 256;
const BLOCK = 96;

/** A woven block, so the luminance correlation has structure to lock onto. */
function patterned(colour: { r: number; g: number; b: number }, side = BLOCK): Buffer {
  const px = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const dark = ((x >> 3) + (y >> 3)) % 2 === 0;
      const k = dark ? 0.55 : 1;
      const i = (y * side + x) * 3;
      px[i] = Math.round(colour.r * k);
      px[i + 1] = Math.round(colour.g * k);
      px[i + 2] = Math.round(colour.b * k);
    }
  return px;
}

/** The product on a plain ground, at a stated place in the frame. */
async function photoAt(colour: { r: number; g: number; b: number }, left: number, top: number): Promise<Uint8Array> {
  const block = await sharp(patterned(colour), { raw: { width: BLOCK, height: BLOCK, channels: 3 } })
    .png()
    .toBuffer();
  const out = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: 250, g: 250, b: 250 } } })
    .composite([{ input: block, top, left }])
    .png()
    .toBuffer();
  return new Uint8Array(out);
}

/** What BACKGROUND_REMOVE gives back: the same product, nothing behind it. */
async function cutoutAt(colour: { r: number; g: number; b: number }, left: number, top: number): Promise<Uint8Array> {
  const block = await sharp(patterned(colour), { raw: { width: BLOCK, height: BLOCK, channels: 3 } })
    .ensureAlpha()
    .png()
    .toBuffer();
  const out = await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: block, top, left }])
    .png()
    .toBuffer();
  return new Uint8Array(out);
}

const RED = { r: 200, g: 30, b: 40 };
const BLUE = { r: 30, g: 60, b: 210 };

/** The average colour of a small square, so a test can ask "what is here?". */
async function patch(image: Uint8Array | Buffer, left: number, top: number, side = 24) {
  const raw = await sharp(image).extract({ left, top, width: side, height: side }).removeAlpha().raw().toBuffer();
  let r = 0;
  let g = 0;
  let b = 0;
  const n = side * side;
  for (let i = 0; i < n; i++) {
    r += raw[i * 3]!;
    g += raw[i * 3 + 1]!;
    b += raw[i * 3 + 2]!;
  }
  return { r: r / n, g: g / n, b: b / n };
}

const reddish = (c: { r: number; g: number; b: number }) => c.r > c.b + 25;
const bluish = (c: { r: number; g: number; b: number }) => c.b > c.r + 25;
const plain = (c: { r: number; g: number; b: number }) => c.r > 200 && c.g > 200 && c.b > 200;

let sourceBytes: Uint8Array = new Uint8Array();
vi.mock('../../modules/provider/adapters/http', () => ({
  fetchBytes: vi.fn(async () => ({ bytes: sourceBytes, mime: 'image/png' })),
}));

function ctxWith(opts: { output: Uint8Array; mask: Uint8Array | null; params?: Record<string, unknown> }) {
  const info = vi.fn();
  const warn = vi.fn();
  const callProvider = vi.fn(async () => ({
    providerKey: 'google:gemini-image',
    providerJobId: 'g-1',
    costMinor: 5,
    artifacts: [{ role: 'image', mime: 'image/png', bytes: opts.output }],
  }));
  const callCapability = vi.fn(async () => {
    if (!opts.mask) throw new Error('background removal is down');
    return { providerKey: 'photoroom:edit', artifacts: [{ role: 'image', mime: 'image/png', bytes: opts.mask }], costMinor: 2 };
  });
  const ctx = {
    row: {
      id: 'g-1',
      workspaceId: 'ws-1',
      capability: 'IMAGE_EDIT',
      input: {
        sourceKey: 'ws-1/p.png',
        prompt: 'on a marble kitchen counter in soft morning light',
        preserveProduct: true,
        aspect: '1:1',
        sizes: ['feed_square'],
        ...opts.params,
      },
    },
    brandKit: null,
    files: { sourceKey: { key: 'ws-1/p.png', url: 'https://signed/p.png', mime: 'image/png' } },
    media: { getBytes: vi.fn(async () => Buffer.from('') as unknown as Uint8Array) },
    callProvider,
    callCapability,
    stage: vi.fn(async () => undefined),
    log: { info, warn, error: vi.fn() },
    signal: new AbortController().signal,
    budgetMs: 120_000,
  } as unknown as PipelineContext;
  return { ctx, callProvider, callCapability, info, warn };
}

const full = (r: { artifacts: Array<{ role: string; bytes?: Uint8Array }> }) => r.artifacts.find((a) => a.role === 'image')!.bytes!;

describe('a model that kept the frame but moved the product', () => {
  it('puts the original back where the product ENDED UP, not where it started', async () => {
    // Source: the product at the top left. Output: the same frame shape,
    // the product's own colours kept — models are good at that — but drawn
    // low and right instead. This scores 0.78: too low to trust as-is, well
    // inside the band where the original gets laid back over the scene.
    sourceBytes = await photoAt(RED, 40, 40);
    const { ctx } = ctxWith({ output: await photoAt(RED, 130, 130), mask: await cutoutAt(RED, 40, 40) });

    const image = full(await brandedImagePipeline(ctx));

    // Where the model put it: the seller's own product, not the model's.
    expect(reddish(await patch(image, 160, 160)), 'the product the model drew was not replaced').toBe(true);
    // Where it used to be: nothing. Laying the original back at its old
    // coordinates is what produced two overlapping products.
    expect(plain(await patch(image, 60, 60)), 'a second copy of the product was left at its old position').toBe(true);
  });

  it('says so in the log, with the place it moved to', async () => {
    sourceBytes = await photoAt(RED, 40, 40);
    const { ctx, warn } = ctxWith({ output: await photoAt(RED, 130, 130), mask: await cutoutAt(RED, 40, 40) });
    await brandedImagePipeline(ctx);
    const said = warn.mock.calls.map((c) => String(c[1])).join(' | ');
    expect(said).toContain('composited back where the model put it');
  });
});

describe('a model that kept the product where it was', () => {
  it('lays the original over the whole frame, which keeps its edges exactly', async () => {
    // Same place, wrong colour: the classic drift the full-frame overlay is for.
    sourceBytes = await photoAt(RED, 80, 80);
    const { ctx, info } = ctxWith({ output: await photoAt(BLUE, 80, 80), mask: await cutoutAt(RED, 80, 80) });

    const image = full(await brandedImagePipeline(ctx));

    expect(reddish(await patch(image, 100, 100))).toBe(true);
    expect(info.mock.calls.map((c) => String(c[1])).join(' | ')).toContain('composited back over the scene');
  });

  it('ships the model output untouched when it kept the product', async () => {
    sourceBytes = await photoAt(RED, 80, 80);
    const { ctx, callProvider } = ctxWith({ output: await photoAt(RED, 80, 80), mask: await cutoutAt(RED, 80, 80) });

    const out = await brandedImagePipeline(ctx);

    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(reddish(await patch(full(out), 100, 100))).toBe(true);
    expect(out.artifacts.filter((a) => a.role === 'variant')).toHaveLength(1);
  });
});

describe('when the cutout cannot be made', () => {
  it('ships the model output rather than failing the customer, and says why', async () => {
    sourceBytes = await photoAt(RED, 80, 80);
    const { ctx, warn } = ctxWith({ output: await photoAt(BLUE, 130, 130), mask: null });

    const image = full(await brandedImagePipeline(ctx));

    expect(bluish(await patch(image, 160, 160))).toBe(true);
    expect(warn.mock.calls.map((c) => String(c[1])).join(' | ')).toContain('skipping the fidelity check');
  });
});
