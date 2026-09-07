/**
 * The merchant shots, at the gate.
 *
 * Every one of these assertions is a credit not spent. A recolour with no
 * colour, a custom model with no photo, a removal with nothing named — each
 * would be accepted by the vendor, billed, and come back wrong. They are
 * refused here instead, before the request leaves the browser, which is the
 * cheapest error handling there is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COST_CODE,
  OFFERED_PRODUCT_MODES,
  PRODUCT_MODES,
  PRODUCT_MODE_KEYS,
  QUEUES,
  SHOT_SIZES,
  SHOT_SIZE_KEYS,
  TAKES_SHOT_SIZE,
  batchUnitCostCode,
  parseCapabilityParams,
  productModeCostCode,
  productShotCostCode,
  queueFor,
} from '@anystudio/shared';

const base = { sourceKey: 'ws/a.jpg', mode: 'ghost_mannequin' as const };
const parse = (params: Record<string, unknown>) => parseCapabilityParams('PRODUCT_SHOT', params);
const issues = (params: Record<string, unknown>) => {
  const r = parse(params);
  expect(r.ok, `expected ${JSON.stringify(params)} to be refused`).toBe(false);
  return r.ok ? {} : r.issues;
};

describe('PRODUCT_SHOT params', () => {
  it('takes a photo and a mode and nothing else — the prompt is never a toll gate', () => {
    const r = parse(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.params as { aspect: string; shadow: string; angleKeys: string[]; prompt?: string };
    expect(p.prompt).toBeUndefined();
    expect(p.aspect).toBe('1:1');
    expect(p.shadow).toBe('soft');
    expect(p.angleKeys).toEqual([]);
  });

  it('accepts every mode with only a photo, except the three that genuinely need a word', () => {
    const needSomething = new Set(['recolor', 'retouch']);
    for (const mode of PRODUCT_MODE_KEYS) {
      const r = parse({ ...base, mode });
      expect(r.ok, `${mode} with just a photo`).toBe(needSomething.has(mode) ? false : true);
    }
  });

  it('refuses a recolour with no colour, and names the field', () => {
    expect(issues({ ...base, mode: 'recolor' })).toHaveProperty('color');
    expect(parse({ ...base, mode: 'recolor', color: '#C8102E' }).ok).toBe(true);
    // A colour that is not a colour is caught by the shape, not by the vendor.
    expect(issues({ ...base, mode: 'recolor', color: 'red' })).toHaveProperty('color');
  });

  it('refuses a removal that does not say what to remove', () => {
    expect(issues({ ...base, mode: 'retouch' })).toHaveProperty('prompt');
    expect(issues({ ...base, mode: 'retouch', prompt: '   ' })).toHaveProperty('prompt');
    expect(parse({ ...base, mode: 'retouch', prompt: 'the hand holding it' }).ok).toBe(true);
  });

  it('refuses a custom model with no photo of the person', () => {
    expect(issues({ ...base, mode: 'on_model', model: 'custom' })).toHaveProperty('modelPhotoKey');
    expect(parse({ ...base, mode: 'on_model', model: 'custom', modelPhotoKey: 'ws/me.jpg' }).ok).toBe(true);
  });

  it('refuses a model, scene or pose the vendor does not have, rather than sending it and being charged', () => {
    expect(issues({ ...base, mode: 'on_model', model: 'beyonce' })).toHaveProperty('model');
    expect(issues({ ...base, mode: 'on_model', scene: 'moon' })).toHaveProperty('scene');
    expect(issues({ ...base, mode: 'on_model', pose: 'breakdance' })).toHaveProperty('pose');
    expect(parse({ ...base, mode: 'on_model', model: 'lena', scene: 'street', pose: 'crossedarms' }).ok).toBe(true);
  });

  it('takes reference angles, up to the cap, and never requires them', () => {
    expect(parse({ ...base, angleKeys: ['ws/b.jpg', 'ws/c.jpg'] }).ok).toBe(true);
    expect(parse({ ...base, angleKeys: ['a/1.jpg', 'a/2.jpg', 'a/3.jpg', 'a/4.jpg'] }).ok).toBe(false);
  });
});

describe('how a shot is priced and queued', () => {
  it('charges more for a model wearing it than for a press', () => {
    expect(productModeCostCode('on_model')).toBe('image.on_model');
    expect(productModeCostCode('ironing')).toBe('image.product_shot');
    // An unknown mode falls back to the ordinary price rather than to nothing.
    expect(productModeCostCode('nonsense')).toBe('image.product_shot');
    expect(DEFAULT_COST_CODE.PRODUCT_SHOT).toBe('image.product_shot');
  });

  it('runs on the fast queue — a two-second shot must never wait behind a four-minute video', () => {
    expect(queueFor('PRODUCT_SHOT')).toBe(QUEUES.fast);
  });
});

/**
 * What the studio is allowed to offer.
 *
 * A mode is only offered once its parameters have been read out of the
 * vendor's own specification. The first version of this feature guessed at
 * five parameter names from the shape of the vendor's app; a guessed
 * parameter is not rejected, it is ignored — so the request succeeds, the
 * credit is taken, and the picture quietly did not do what was asked.
 */
describe('only offering what the vendor documented', () => {
  it('offers the modes whose parameters are confirmed, and holds back the ones that are not', () => {
    expect(OFFERED_PRODUCT_MODES).toContain('on_model');
    expect(OFFERED_PRODUCT_MODES).toContain('ghost_mannequin');
    expect(OFFERED_PRODUCT_MODES).toContain('flat_lay');
    expect(OFFERED_PRODUCT_MODES).toContain('ironing');
    // Not in the published spec: written, switched off, one word from being on.
    expect(OFFERED_PRODUCT_MODES).not.toContain('recolor');
    expect(OFFERED_PRODUCT_MODES).not.toContain('retouch');
  });

  it('still parses an unoffered mode, so turning one on needs no schema change', () => {
    expect(parse({ ...base, mode: 'recolor', color: '#C8102E' }).ok).toBe(true);
  });

  it('gives every offered mode a price and a name a merchant would use', () => {
    for (const k of OFFERED_PRODUCT_MODES) {
      const m = PRODUCT_MODES[k];
      expect(m.label.length, k).toBeGreaterThan(0);
      expect(m.note.length, k).toBeGreaterThan(0);
      expect(productModeCostCode(k)).toMatch(/^image\./);
    }
  });
});

/**
 * Who decides what a shot costs.
 *
 * The batch quantity is derived on the server with a comment saying why —
 * "never from the client, or forty premium renders would cost one". The same
 * hole was open one line above it: a merchant shot took whatever cost code
 * the request carried, so "on a model, for printing" could be billed as a
 * press. These are the tests that keep it shut.
 */
describe('what a merchant shot costs', () => {
  it('charges for the shot that was asked for, not the cheapest one', () => {
    expect(productShotCostCode('on_model')).toBe('image.on_model');
    expect(productShotCostCode('ironing')).toBe('image.product_shot');
    // A press is not a model shot however the request is dressed up.
    expect(productShotCostCode('ironing', 'printing')).toBe('image.product_shot');
  });

  it('charges more for a bigger render, because it is more of the vendor’s work', () => {
    expect(productShotCostCode('on_model', 'posting')).toBe('image.on_model');
    expect(productShotCostCode('on_model', 'listing')).toBe('image.on_model.2k');
    expect(productShotCostCode('on_model', 'printing')).toBe('image.on_model.4k');
  });

  it('falls back to the plain shot for anything it does not recognise', () => {
    expect(productShotCostCode(undefined)).toBe('image.product_shot');
    expect(productShotCostCode('made-up-mode')).toBe('image.product_shot');
    expect(productShotCostCode('on_model', 'made-up-size')).toBe('image.on_model');
  });

  it('prices a batch of shots by the same rule as one', () => {
    expect(batchUnitCostCode('PRODUCT_SHOT', { mode: 'on_model', shotSize: 'printing' })).toBe('image.on_model.4k');
    expect(batchUnitCostCode('PRODUCT_SHOT', { mode: 'ironing' })).toBe('image.product_shot');
  });

  /**
   * Read from the seed's own source rather than imported from it: importing
   * the seed pulls in a database client, and the thing worth checking is the
   * file an operator actually edits.
   */
  it('has a price seeded for every code it can produce', () => {
    const seed = readFileSync(join(__dirname, '../../../../../packages/db/prisma/seed.ts'), 'utf8');
    const seeded = new Set([...seed.matchAll(/code:\s*'([^']+)'/g)].map((m) => m[1]!));
    expect(seeded.size, 'the seed scanner found no cost codes — the pattern has drifted').toBeGreaterThan(10);
    for (const mode of OFFERED_PRODUCT_MODES)
      for (const size of [undefined, ...SHOT_SIZE_KEYS]) {
        const code = productShotCostCode(mode, size);
        expect(seeded.has(code), `${mode} at ${size ?? 'default'} size wants "${code}", which nothing seeds`).toBe(true);
      }
  });
});

describe('the sizes a merchant is offered', () => {
  it('names them for what the picture is for, never for a sales tier', () => {
    for (const k of SHOT_SIZE_KEYS) {
      expect(SHOT_SIZES[k].label).not.toMatch(/standard|advanced|premium/i);
      // And says what it actually means, in numbers.
      expect(SHOT_SIZES[k].note).toMatch(/\d/);
    }
  });

  it('sends the vendor’s own word for it, not ours', () => {
    expect(SHOT_SIZES.posting.vendor).toBe('standard');
    expect(SHOT_SIZES.listing.vendor).toBe('advanced');
    expect(SHOT_SIZES.printing.vendor).toBe('premium');
  });

  it('offers it only where the vendor documents it', () => {
    // Sending it on a mode with no such parameter would send a key nothing
    // reads — the class of mistake that put five wrong names in the adapter.
    expect([...TAKES_SHOT_SIZE]).toEqual(['on_model']);
  });
});
