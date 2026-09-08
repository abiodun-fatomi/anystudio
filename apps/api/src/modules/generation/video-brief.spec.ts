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

describe('UGC presenters versus product reels', () => {
  it('accepts off-screen speech with clip sound but rejects scripts too long for a reel', () => {
    expect(reel({ audio: true, narration: { voiceId: 'voice-1', script: 'Our bottle is ready.' } }).ok).toBe(true);
    expect(reel({ narration: { voiceId: 'voice-1', script: 'word '.repeat(100) } }).ok).toBe(false);
    expect(reel({ shots: 2, format: 'ugc', presenter: { kind: 'stock', key: 'daphne' }, narration: { voiceId: 'voice-1', script: 'Hello.' } }).ok).toBe(false);
  });
  it('requires a presenter for multi-shot UGC before accepting the request', () => {
    expect(reel({ format: 'ugc', shots: 4 }).ok).toBe(false);
    expect(reel({ format: 'ugc', shots: 4, presenter: { kind: 'stock', key: 'daphne' } }).ok).toBe(true);
  });
  it('keeps reels and internal UGC product shots presenter-free', () => {
    expect(reel({ format: 'ugc' }).ok).toBe(true);
    expect(reel({ format: 'ugc', shotIndex: 0 }).ok).toBe(true);
    expect(reel({ presenter: { kind: 'stock', key: 'daphne' } }).ok).toBe(false);
    expect(reel({ format: 'reveal', shots: 4, presenter: { kind: 'stock', key: 'daphne' } }).ok).toBe(false);
  });
  it('requires an explicit face selection and permission for uploaded faces', () => {
    expect(reel({ format: 'ugc', shots: 2, presenter: { kind: 'stock' } }).ok).toBe(false);
    expect(reel({ format: 'ugc', shots: 2, presenter: { kind: 'photo', photoKey: 'ws/me.jpg' } }).ok).toBe(false);
    expect(reel({ format: 'ugc', shots: 2, presenter: { kind: 'photo', photoKey: 'ws/me.jpg', consent: true } }).ok).toBe(true);
  });
});

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
