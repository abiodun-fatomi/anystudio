/**
 * The merchant shots, and the one judgement that decides whether they work.
 *
 * The fidelity check is the best thing in this codebase and the easiest thing
 * to point at the wrong target. Aimed at "Press it" it catches a model that
 * swapped the seller's dress for a similar one — the failure a merchant would
 * not notice until a customer did. Aimed at "On a model" it refuses every
 * good result, because a garment worn by a person is SUPPOSED to look
 * different from the same garment flat on a bed.
 *
 * So the tests that matter here are the two halves of that: a shot that
 * should be refused is refused, and a shot that should never be judged is
 * shipped no matter what the number says.
 *
 * The rest of it is the difference between a picture and something a seller
 * can post — the price on it, and every size cut.
 */
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { KEEPS_GEOMETRY, OFFERED_PRODUCT_MODES, judgesShape, type ProductMode } from '@anystudio/shared';
import { productShotPipeline } from './product-shot';
import type { PipelineContext } from './index';
import { fetchBytes } from '../../modules/provider/adapters/http';

/**
 * A product with a pattern in it, on a white ground, offset so it has a
 * findable place. The pattern matters: the check compares luminance
 * structure, and a flat block of colour has no structure to compare — a
 * fixture without texture measures zero against itself.
 */
function patterned(colour: { r: number; g: number; b: number }, side = 96): Buffer {
  const px = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      // Deterministic weave: light and dark cells, like a printed fabric.
      const dark = ((x >> 3) + (y >> 3)) % 2 === 0;
      const k = dark ? 0.55 : 1;
      const i = (y * side + x) * 3;
      px[i] = Math.round(colour.r * k);
      px[i + 1] = Math.round(colour.g * k);
      px[i + 2] = Math.round(colour.b * k);
    }
  return px;
}

async function photo(colour: { r: number; g: number; b: number }, size = 256): Promise<Uint8Array> {
  const side = 96;
  const block = await sharp(patterned(colour, side), { raw: { width: side, height: side, channels: 3 } })
    .png()
    .toBuffer();
  const out = await sharp({ create: { width: size, height: size, channels: 3, background: { r: 250, g: 250, b: 250 } } })
    .composite([{ input: block, top: 70, left: 70 }])
    .png()
    .toBuffer();
  return new Uint8Array(out);
}

/** The same product with the ground taken away — what BACKGROUND_REMOVE returns. */
async function cutout(colour: { r: number; g: number; b: number }, size = 256): Promise<Uint8Array> {
  const side = 96;
  const block = await sharp(patterned(colour, side), { raw: { width: side, height: side, channels: 3 } })
    .ensureAlpha()
    .png()
    .toBuffer();
  const out = await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: block, top: 70, left: 70 }])
    .png()
    .toBuffer();
  return new Uint8Array(out);
}

/** A frame with no product in it: fine noise, nothing to find. */
async function nothing(size = 256): Promise<Uint8Array> {
  const px = Buffer.alloc(size * size * 3);
  let seed = 7;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = 120 + (seed % 24);
  }
  const out = await sharp(px, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
  return new Uint8Array(out);
}

const RED = { r: 200, g: 30, b: 40 };
const BLUE = { r: 30, g: 60, b: 210 };

// The source is fetched by URL; in a test it is just bytes.
let sourceBytes: Uint8Array = new Uint8Array();
vi.mock('../../modules/provider/adapters/http', () => ({
  fetchBytes: vi.fn(async () => ({ bytes: sourceBytes, mime: 'image/png' })),
}));

function ctxWith(opts: { params: Record<string, unknown>; output: Uint8Array; mask: Uint8Array | null; brandKit?: object | null }) {
  const stage = vi.fn(async () => undefined);
  const warn = vi.fn();
  const callProvider = vi.fn(async () => ({
    providerKey: 'photoroom:edit',
    providerJobId: 'pr-1',
    costMinor: 2,
    artifacts: [{ role: 'image', mime: 'image/png', bytes: opts.output }],
  }));
  const callCapability = vi.fn(async () => {
    if (!opts.mask) throw new Error('background removal is down');
    return { providerKey: 'x:cut', artifacts: [{ role: 'image', mime: 'image/png', bytes: opts.mask }], costMinor: 1 };
  });
  const ctx = {
    row: { id: 'g-1', workspaceId: 'ws-1', capability: 'PRODUCT_SHOT', input: opts.params },
    brandKit: opts.brandKit ?? null,
    db: { providerModel: { findUnique: vi.fn(async () => null) } },
    files: { sourceKey: { key: 'ws-1/p.png', url: 'https://signed/p.png', mime: 'image/png' } },
    media: { getBytes: vi.fn(async () => Buffer.from(sourceBytes)) },
    callProvider,
    callCapability,
    stage,
    log: { info: vi.fn(), warn, error: vi.fn() },
    signal: new AbortController().signal,
    budgetMs: 120_000,
  } as unknown as PipelineContext;
  return { ctx, callProvider, callCapability, stage, warn };
}

const params = (over: Record<string, unknown> = {}) => ({
  sourceKey: 'ws-1/p.png',
  mode: 'ironing',
  aspect: '1:1',
  angleKeys: [],
  subject: 'auto',
  shadow: 'soft',
  sizes: ['feed_square', 'story'],
  ...over,
});

describe('Beautify preserves the entire photo', () => {
  it('enhances the source without a provider or cutout, even when the provider would lose the subject', async () => {
    sourceBytes = await photo(RED);
    const { ctx, callProvider, callCapability } = ctxWith({ params: params({ mode: 'beautify' }), output: await nothing(), mask: null });
    const result = await productShotPipeline(ctx);
    expect(callProvider).not.toHaveBeenCalled();
    expect(callCapability).not.toHaveBeenCalled();
    expect(result.providerKey).toBe('local:beautify');
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts[0]).toMatchObject({ width: 256, height: 256 });
    const actual = await sharp(result.artifacts[0]!.bytes!).raw().toBuffer();
    const expected = await sharp(sourceBytes).rotate().toColourspace('srgb').modulate({ brightness: 1.04, saturation: 1.03 }).raw().toBuffer();
    expect(actual).toEqual(expected);
    expect(result.artifacts[2]).toMatchObject({ width: 1080, height: 1920 });
  });
});

describe('which modes the check is allowed to refuse', () => {
  it('judges the ones that hand the product back unchanged', () => {
    for (const m of ['ironing', 'beautify', 'expand'] as ProductMode[]) expect(judgesShape(m), m).toBe(true);
  });

  it('never judges the ones whose whole job is to reshape it', () => {
    // A dress on a body, inflated to a torso, or laid out square is meant to
    // look different. Refusing on a low score here refuses the good ones.
    for (const m of ['on_model', 'ghost_mannequin', 'flat_lay'] as ProductMode[]) expect(judgesShape(m), m).toBe(false);
  });

  it('has an answer for every mode the studio offers', () => {
    for (const m of OFFERED_PRODUCT_MODES) expect(typeof judgesShape(m), m).toBe('boolean');
    for (const m of KEEPS_GEOMETRY) expect(judgesShape(m), m).toBe(true);
  });
});

describe('a shot that kept the product', () => {
  it('ships it, with the price on it and every size cut', async () => {
    sourceBytes = await photo(RED);
    const { ctx, callProvider } = ctxWith({
      params: params({ price: '₦12,500', businessName: 'Ada Fabrics' }),
      output: await photo(RED),
      mask: await cutout(RED),
      brandKit: { businessName: 'Ada Fabrics', palette: ['#D6006E'], showPrice: true, watermark: null, logoKey: null },
    });

    const out = await productShotPipeline(ctx);

    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(out.providerKey).toBe('photoroom:edit');
    // The full picture, plus one for each size asked for.
    expect(out.artifacts.filter((a) => a.role === 'image')).toHaveLength(1);
    expect(out.artifacts.filter((a) => a.role === 'variant')).toHaveLength(2);
    expect(out.artifacts.find((a) => a.size === 'story')).toBeTruthy();
  });

  it('says it is using the other angles, so a merchant learns to add them', async () => {
    sourceBytes = await photo(RED);
    const { ctx, stage } = ctxWith({ params: params({ angleKeys: ['ws-1/back.png', 'ws-1/side.png'] }), output: await photo(RED), mask: await cutout(RED) });
    await productShotPipeline(ctx);
    expect(stage.mock.calls.map((c) => c[2]).join(' | ')).toContain('your 3 photos');
  });
});

describe('a shot that came back as a different product', () => {
  it('asks again, then refuses rather than handing over someone else’s dress', async () => {
    // Nothing recognisable in the frame: it cannot be repaired, only refused.
    sourceBytes = await photo(RED);
    const { ctx, callProvider } = ctxWith({ params: params({ mode: 'ironing' }), output: await nothing(), mask: await cutout(RED) });

    await expect(productShotPipeline(ctx)).rejects.toMatchObject({ kind: 'LOW_QUALITY' });
    expect(callProvider).toHaveBeenCalledTimes(2);
  });

  it('repairs rather than refuses when the product is still there but drifted', async () => {
    // The shape is right and the place is right; the colour is not. Refusing
    // would waste the whole generation, so the seller's own pixels go back
    // over the model's scene and they keep the new light and their real item.
    sourceBytes = await photo(RED);
    const { ctx, callProvider, warn } = ctxWith({ params: params({ mode: 'ironing' }), output: await photo(BLUE), mask: await cutout(RED) });

    const out = await productShotPipeline(ctx);
    expect(out.artifacts.filter((a) => a.role === 'variant')).toHaveLength(2);
    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).toContain('put back where it was found');
  });

  /** The regression this file exists for. */
  it('does not refuse an on-model shot for looking different, because that is the point', async () => {
    sourceBytes = await photo(RED);
    const { ctx, callProvider } = ctxWith({ params: params({ mode: 'on_model', model: 'avery' }), output: await photo(BLUE), mask: await cutout(RED) });

    const out = await productShotPipeline(ctx);
    expect(out.artifacts.length).toBeGreaterThan(0);
    // And it does not waste a second paid call chasing a score it will not use.
    expect(callProvider).toHaveBeenCalledTimes(1);
  });
});

describe('when the check itself cannot run', () => {
  it('still makes the shot rather than spending the credit on our plumbing', async () => {
    sourceBytes = await photo(RED);
    const { ctx, callProvider, warn } = ctxWith({ params: params(), output: await photo(BLUE), mask: null });

    const out = await productShotPipeline(ctx);
    expect(out.artifacts.filter((a) => a.role === 'variant')).toHaveLength(2);
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('without the fidelity check');
  });

  it('does not make a paid shot after cancellation stopped the cutout step', async () => {
    sourceBytes = await photo(RED);
    const cancellation = new Error('generation cancelled');
    const controller = new AbortController();
    controller.abort(cancellation);
    const { ctx, callProvider } = ctxWith({ params: params(), output: await photo(BLUE), mask: null });
    ctx.signal = controller.signal;

    await expect(productShotPipeline(ctx)).rejects.toBe(cancellation);
    expect(callProvider).not.toHaveBeenCalled();
    expect(fetchBytes).toHaveBeenLastCalledWith('product-shot', 'https://signed/p.png', 60_000, controller.signal);
  });
});

describe('what the customer is told while it happens', () => {
  it('never names the vendor doing the work', async () => {
    sourceBytes = await photo(RED);
    const { ctx, stage } = ctxWith({ params: params(), output: await photo(RED), mask: await cutout(RED) });
    await productShotPipeline(ctx);
    const said = stage.mock.calls.map((c) => c[2]).filter(Boolean) as string[];
    expect(said.length).toBeGreaterThan(2);
    const { namesAVendor } = await import('@anystudio/shared');
    for (const line of said) expect(namesAVendor(line), line).toBe(false);
  });
});
