/**
 * The exact words the vendor answers to.
 *
 * This adapter has now been wrong about parameter names twice. The first time
 * five names were invented from the shape of the vendor's app — `recolor.*`,
 * `retouch.*`, `beautify.prompt`, `expand.prompt`, a top-level `size`. The
 * second time the names were right but the SHAPE was not: `virtualModel.model`
 * is an object, either a named preset or a photo of your own, and sending the
 * bare string "avery" is a 400 that reads "must match a schema in anyOf".
 *
 * Neither was caught by a test, because every test in this repository until
 * now asserted on our own objects. A live run against a sandbox key found
 * both in eleven seconds.
 *
 * So this asserts on the thing that actually leaves the building: the query
 * string. It cannot prove a name is right — only the vendor can, and
 * scripts/verify-photoroom.ts is how you ask — but it can hold the answers
 * once they are known, which is the half that keeps regressing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderInput } from '@anystudio/shared';
import { PhotoroomProvider } from './photoroom.adapter';

/** Run the adapter with the network stubbed, and hand back what it asked for. */
async function sent(params: Record<string, unknown>, files: ProviderInput['files'] = {}): Promise<URLSearchParams> {
  let asked = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked = url;
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
    }),
  );
  const [provider] = PhotoroomProvider.all('k');
  await provider!.generate(
    {
      generationId: 'g',
      workspaceId: 'ws',
      capability: 'PRODUCT_SHOT',
      params,
      files: { sourceKey: { url: 'https://x/p.jpg', mime: 'image/jpeg' }, ...files },
      config: {},
    },
    { timeoutMs: 1000, signal: new AbortController().signal },
  );
  vi.unstubAllGlobals();
  return new URL(asked).searchParams;
}

const shot = (over: Record<string, unknown>) => ({
  sourceKey: 'ws/p.jpg',
  aspect: '1:1',
  angleKeys: [],
  subject: 'auto',
  shadow: 'soft',
  shotSize: 'posting',
  sizes: [],
  ...over,
});

describe('putting a garment on a model', () => {
  /**
   * The bug a live run found. `virtualModel.model` is an object with two
   * branches — a named preset or a photo — and the dotted query path is how
   * the vendor spells a nested field. A bare string is refused.
   */
  it('names the preset model as a nested field, not as a bare value', async () => {
    const q = await sent(shot({ mode: 'on_model', model: 'avery' }));
    expect(q.get('virtualModel.model.preset.name')).toBe('avery');
    expect(q.get('virtualModel.model'), 'the bare form is what returned "must match a schema in anyOf"').toBeNull();
  });

  it('does the same for the scene', async () => {
    const q = await sent(shot({ mode: 'on_model', model: 'avery', scene: 'street' }));
    expect(q.get('virtualModel.scene.preset.name')).toBe('street');
    expect(q.get('virtualModel.scene')).toBeNull();
  });

  it('leaves the pose flat, because that one really is a plain string', async () => {
    const q = await sent(shot({ mode: 'on_model', model: 'avery', pose: 'standing' }));
    expect(q.get('virtualModel.pose')).toBe('standing');
    expect(q.get('virtualModel.pose.preset.name')).toBeNull();
  });

  it('sends a seller’s own model as a custom image, on its own branch', async () => {
    const q = await sent(shot({ mode: 'on_model', model: 'custom', modelPhotoKey: 'ws/me.jpg' }), {
      modelPhotoKey: { url: 'https://x/me.jpg', mime: 'image/jpeg' },
    });
    expect(q.get('virtualModel.model.custom.imageUrl')).toBe('https://x/me.jpg');
    // Never both: the two branches are mutually exclusive.
    expect(q.get('virtualModel.model.preset.name')).toBeNull();
  });

  it('keeps the background, because the person wearing it IS the new background', async () => {
    const q = await sent(shot({ mode: 'on_model', model: 'avery' }));
    expect(q.get('removeBackground')).toBe('false');
  });

  it('passes every extra angle under one repeated field', async () => {
    const q = await sent(shot({ mode: 'on_model', model: 'avery', angleKeys: ['ws/b.jpg', 'ws/c.jpg'] }), {
      'angleKeys[0]': { url: 'https://x/b.jpg', mime: 'image/jpeg' },
      'angleKeys[1]': { url: 'https://x/c.jpg', mime: 'image/jpeg' },
    });
    // No brackets in the name: the spec calls it an array and multipart
    // convention repeats the plain field.
    expect(q.getAll('virtualModel.additionalProductImages')).toEqual(['https://x/b.jpg', 'https://x/c.jpg']);
  });

  it('asks for the size the merchant chose', async () => {
    const q = await sent(shot({ mode: 'on_model', model: 'avery', shotSize: 'printing' }));
    expect(q.get('virtualModel.quality')).toBe('premium');
  });
});

describe('widening the frame', () => {
  /** The vendor's own words: "expand.mode will activate when `removeBackground` is set to false". */
  it('keeps the background, because continuing the surroundings needs surroundings', async () => {
    const q = await sent(shot({ mode: 'expand' }));
    expect(q.get('expand.mode')).toBe('ai.auto');
    expect(q.get('removeBackground')).toBe('false');
    expect(q.get('outputSize')).toBe('auto');
  });
});

describe('the modes that work on the product itself', () => {
  it('presses without options, because the spec offers none', async () => {
    const q = await sent(shot({ mode: 'ironing' }));
    expect(q.get('ironing.mode')).toBe('ai.auto');
    expect(q.get('ironing.size'), 'ironing has no size in the spec').toBeNull();
  });

  it('tunes the studio shot by subject', async () => {
    expect((await sent(shot({ mode: 'beautify', subject: 'food' }))).get('beautify.mode')).toBe('ai.food');
  });

  it('sizes the ghost mannequin and the flat lay on themselves', async () => {
    expect((await sent(shot({ mode: 'ghost_mannequin' }))).get('ghostMannequin.size')).toBe('SQUARE_HD');
    expect((await sent(shot({ mode: 'flat_lay' }))).get('flatLay.size')).toBe('SQUARE_HD');
  });

  it('sends the quality tier on no mode but the model shot', async () => {
    // It exists on virtualModel and nowhere else; elsewhere it is a key
    // nothing reads, billed, and silently ignored.
    for (const mode of ['ghost_mannequin', 'flat_lay', 'ironing', 'beautify', 'expand'])
      expect((await sent(shot({ mode, shotSize: 'printing' }))).get('virtualModel.quality'), mode).toBeNull();
  });
});

/**
 * The endpoint's original job is background removal, so every mode is a cutout
 * unless it says otherwise. A live run showed what that means in practice:
 * pressed trousers floating on nothing, which is not what "Press it" offers.
 */
describe('who asked for a cutout', () => {
  it('keeps the room a merchant photographed their goods in', async () => {
    for (const mode of ['ironing', 'beautify', 'expand', 'on_model'])
      expect((await sent(shot({ mode, ...(mode === 'on_model' ? { model: 'avery' } : {}) }))).get('removeBackground'), mode).toBe('false');
  });

  it('leaves the two shapes that are isolated by nature alone', async () => {
    // A garment holding its own shape and a flat lay come back cut out
    // because that is what those shots ARE, not as a side effect.
    for (const mode of ['ghost_mannequin', 'flat_lay']) expect((await sent(shot({ mode }))).get('removeBackground'), mode).toBeNull();
  });
});

describe('a mode we have not confirmed', () => {
  it('is refused rather than half-sent', async () => {
    // recolor and retouch are `verified: false`: their parameters were never
    // in the specification. A request the vendor half-understands still bills.
    await expect(sent(shot({ mode: 'recolor', color: '#C8102E' }))).rejects.toThrow(/cannot do "recolor"/);
  });
});
