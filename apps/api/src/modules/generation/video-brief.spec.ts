/**
 * Picking a format is a complete brief.
 *
 * The video tool demanded a prompt from everyone, which is the wrong ask in
 * both directions. For a multi-shot ad the planner was ALREADY handed the
 * format's brief and treated the seller's words as optional direction on top
 * — the requirement was a formality that stopped people at the door. For a
 * single reel there was no planner at all, so the typed words went straight
 * to the video model, and a merchant who wanted a price-drop reel had to
 * invent a camera move to get one.
 *
 * So a format now carries its own direction, and a blank prompt is filled in
 * once, on the server, and recorded on the row — not patched in later by
 * something downstream, where the seller could never see what was actually
 * asked for and two code paths could disagree about it.
 */
import { describe, expect, it } from 'vitest';
import { AD_FORMATS, REEL_BRIEF, namesAVendor, parseCapabilityParams, type AdFormat } from '@anystudio/shared';

const reel = (over: Record<string, unknown> = {}) => parseCapabilityParams('IMAGE_TO_VIDEO', { sourceKey: 'ws/a.jpg', ...over });

describe('a reel with nothing typed', () => {
  it('is a valid request', () => {
    const r = reel({ format: 'price_drop' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('carries the chosen format’s own direction', () => {
    const r = reel({ format: 'price_drop' });
    if (r.ok) expect(r.params.prompt).toBe(REEL_BRIEF.price_drop);
  });

  it('defaults the format too, so a photo alone is enough', () => {
    const r = reel();
    if (r.ok) {
      expect(r.params.format).toBe('reveal');
      expect(r.params.prompt).toBe(REEL_BRIEF.reveal);
    }
  });

  it('treats whitespace as nothing typed', () => {
    const r = reel({ format: 'unboxing', prompt: '   ' });
    if (r.ok) expect(r.params.prompt).toBe(REEL_BRIEF.unboxing);
  });
});

describe('a reel with words', () => {
  it('lets the seller overrule the format', () => {
    const r = reel({ format: 'price_drop', prompt: 'hold still on the label' });
    if (r.ok) expect(r.params.prompt).toBe('hold still on the label');
  });
});

describe('the directions themselves', () => {
  it('has one for every format a seller can pick', () => {
    for (const f of AD_FORMATS) {
      expect(REEL_BRIEF[f], f).toBeTruthy();
      // Long enough to actually direct a shot, short enough for a model.
      expect(REEL_BRIEF[f].length, f).toBeGreaterThan(30);
      expect(REEL_BRIEF[f].length, f).toBeLessThan(200);
    }
  });

  it('describes a camera, not a vendor', () => {
    for (const f of AD_FORMATS) expect(namesAVendor(REEL_BRIEF[f]), f).toBe(false);
  });

  it('gives each format a different one, or the choice means nothing', () => {
    expect(new Set(AD_FORMATS.map((f: AdFormat) => REEL_BRIEF[f])).size).toBe(AD_FORMATS.length);
  });
});
