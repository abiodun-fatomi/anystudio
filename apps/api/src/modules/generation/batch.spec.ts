/**
 * A folder of forty, and the two ways it could cost someone money unfairly.
 *
 * TOO CHEAP. The price is the child's own credit cost times the number of
 * photos, and the server counts the photos itself. A client that sent forty
 * on-a-model shots claiming the price of one press would get forty premium
 * renders for a press's fee.
 *
 * TOO DEAR. Three failures out of forty is not a failed generation — the
 * merchant has thirty-seven pictures they waited for. Refusing the lot would
 * throw those away; keeping the whole fee would charge for three that do not
 * exist. The parent succeeds and refunds exactly the failed share.
 */
import { describe, expect, it } from 'vitest';
import { BATCHABLE, BATCH_MAX, batchUnitCostCode, isBatchable, parseCapabilityParams, queueFor, QUEUES } from '@anystudio/shared';

const photos = (n: number) => Array.from({ length: n }, (_, i) => `ws/2026/01/p${i}.jpg`);
const parse = (params: Record<string, unknown>) => parseCapabilityParams('BATCH', params);
const issues = (params: Record<string, unknown>) => {
  const r = parse(params);
  expect(r.ok, `expected ${JSON.stringify(params).slice(0, 120)} to be refused`).toBe(false);
  return r.ok ? {} : r.issues;
};

describe('what a batch will accept', () => {
  it('takes a list of photos and the settings every one of them gets', () => {
    const r = parse({ of: 'PRODUCT_SHOT', sourceKeys: photos(3), params: { mode: 'ghost_mannequin' } });
    expect(r.ok).toBe(true);
  });

  it('needs at least two photos — one photo is just a shot', () => {
    expect(issues({ of: 'PRODUCT_SHOT', sourceKeys: photos(1), params: { mode: 'ironing' } })).toHaveProperty('sourceKeys');
  });

  it('has a ceiling, so a runaway request cannot open ten thousand jobs', () => {
    expect(parse({ of: 'PRODUCT_SHOT', sourceKeys: photos(BATCH_MAX), params: { mode: 'ironing' } }).ok).toBe(true);
    expect(issues({ of: 'PRODUCT_SHOT', sourceKeys: photos(BATCH_MAX + 1), params: { mode: 'ironing' } })).toHaveProperty('sourceKeys');
  });

  it('only batches things that take one photo and give back a picture', () => {
    for (const c of BATCHABLE) expect(isBatchable(c)).toBe(true);
    // A song has no folder, a collage is already many photos, an ad is a plan.
    for (const c of ['MUSIC', 'COLLAGE', 'VIDEO_STITCH', 'BATCH']) expect(isBatchable(c)).toBe(false);
    expect(issues({ of: 'MUSIC', sourceKeys: photos(3), params: {} })).toBeTruthy();
  });
});

describe('validating the settings once, before any credit moves', () => {
  it('refuses a folder whose settings the child capability would reject, and points at the field', () => {
    // A recolour with no colour: forty children would each fail the same way.
    const found = issues({ of: 'PRODUCT_SHOT', sourceKeys: photos(40), params: { mode: 'recolor' } });
    expect(Object.keys(found).some((k) => k.startsWith('params.'))).toBe(true);
    expect(found['params.color']).toBeTruthy();
  });

  it('refuses a model the vendor does not have, rather than paying forty times to find out', () => {
    expect(issues({ of: 'PRODUCT_SHOT', sourceKeys: photos(12), params: { mode: 'on_model', model: 'beyonce' } })).toHaveProperty('params.model');
  });

  it('accepts settings the child is happy with', () => {
    expect(parse({ of: 'PRODUCT_SHOT', sourceKeys: photos(12), params: { mode: 'on_model', model: 'lena', scene: 'street' } }).ok).toBe(true);
  });
});

describe('what a batch costs', () => {
  it('prices each photo under the shot it actually asked for', () => {
    expect(batchUnitCostCode('PRODUCT_SHOT', { mode: 'on_model' })).toBe('image.on_model');
    expect(batchUnitCostCode('PRODUCT_SHOT', { mode: 'ironing' })).toBe('image.product_shot');
    expect(batchUnitCostCode('BACKGROUND_REMOVE', {})).toBe('image.bg_remove');
    expect(batchUnitCostCode('UPSCALE', {})).toBe('image.upscale');
  });

  it('falls back to the ordinary shot price when the mode is missing or nonsense, never to free', () => {
    expect(batchUnitCostCode('PRODUCT_SHOT', {})).toBe('image.product_shot');
    expect(batchUnitCostCode('PRODUCT_SHOT', { mode: 'nonsense' })).toBe('image.product_shot');
  });

  it('runs its parent on the fast queue — it waits on children and holds no worker', () => {
    expect(queueFor('BATCH')).toBe(QUEUES.fast);
  });
});
