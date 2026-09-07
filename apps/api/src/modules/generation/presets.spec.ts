/**
 * Forty-two looks, and the ways a catalogue this size goes wrong.
 *
 * The panel used to list every preset inline. At seventeen that was a long
 * scroll; at forty-two it is the tool-strip mistake again — a wall, not a
 * menu. So the panel keeps the first few of each group and the rest live
 * behind a search box.
 *
 * Which means the failure mode moves: a look that cannot be found by typing
 * the word a seller would use is a look that does not exist. These tests are
 * mostly about that.
 */
import { describe, expect, it } from 'vitest';
import {
  ASPECTS,
  ASPECT_USE,
  PHOTO_PRESETS,
  PRESETS_INLINE,
  PRESET_GROUPS,
  namesAVendor,
  parseCapabilityParams,
  preset,
  presetCapability,
  presetsIn,
  searchPresets,
  type PresetGroup,
} from '@anystudio/shared';

describe('the catalogue', () => {
  it('is big enough to be worth searching', () => {
    expect(PHOTO_PRESETS.length).toBeGreaterThan(30);
  });

  it('has no two looks under one key', () => {
    const keys = PHOTO_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('files every look under a group that exists, and leaves no group empty', () => {
    for (const p of PHOTO_PRESETS) expect(PRESET_GROUPS[p.group], `${p.key} → ${p.group}`).toBeTruthy();
    for (const g of Object.keys(PRESET_GROUPS) as PresetGroup[]) expect(presetsIn(g).length, g).toBeGreaterThan(0);
  });

  it('gives every group enough to fill the panel’s row', () => {
    // A group showing two tiles next to one showing four reads as broken.
    for (const g of Object.keys(PRESET_GROUPS) as PresetGroup[]) expect(presetsIn(g).length, g).toBeGreaterThanOrEqual(PRESETS_INLINE);
  });

  it('gives every look a real swatch, so no tile renders blank', () => {
    for (const p of PHOTO_PRESETS) {
      if (p.swatch.transparent) continue;
      expect(p.swatch.colors.length, p.key).toBeGreaterThan(0);
      for (const c of p.swatch.colors) expect(c, `${p.key}: "${c}"`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('sends every scene look a prompt, and every cut look a colour', () => {
    for (const p of PHOTO_PRESETS) {
      const params = { sourceKey: 'ws/a.jpg', ...p.params };
      const parsed = parseCapabilityParams(presetCapability(p), params);
      expect(parsed.ok, `${p.key}: ${JSON.stringify(parsed)}`).toBe(true);
    }
  });

  it('describes a place, never a vendor', () => {
    for (const p of PHOTO_PRESETS) {
      expect(namesAVendor(p.name), p.key).toBe(false);
      expect(namesAVendor(p.note), p.key).toBe(false);
    }
  });
});

describe('finding a look by typing', () => {
  it('opens on everything', () => {
    expect(searchPresets('')).toHaveLength(PHOTO_PRESETS.length);
    expect(searchPresets('   ')).toHaveLength(PHOTO_PRESETS.length);
  });

  /** The words a Nigerian seller would actually type, and what each must reach. */
  const asked: Array<[string, string]> = [
    ['owambe', 'owambe'],
    ['wedding', 'owambe'],
    ['aso ebi', 'owambe'],
    ['jollof', 'plated'],
    ['wig', 'salon'],
    ['yard', 'ankara'],
    ['wax print', 'ankara'],
    ['sallah', 'sallah'],
    ['eid', 'sallah'],
    ['school', 'backtoschool'],
    ['perfume', 'glassshelf'],
    ['zobo', 'drink'],
    ['small chops', 'servingboard'],
    ['marble', 'marble'],
  ];
  for (const [word, key] of asked) {
    it(`“${word}” finds ${key}`, () => {
      const found = searchPresets(word).map((p) => p.key);
      expect(found, `“${word}” found ${found.join(', ') || 'nothing'}`).toContain(key);
    });
  }

  it('narrows on every word rather than widening', () => {
    const found = searchPresets('plain white').map((p) => p.key);
    expect(found).toContain('white');
    expect(found).not.toContain('owambe');
  });

  it('comes back empty rather than wrong', () => {
    expect(searchPresets('zzzz-nothing')).toHaveLength(0);
  });

  it('resolves anything it returns', () => {
    for (const p of searchPresets('')) expect(preset(p.key), p.key).toBeTruthy();
  });
});

/**
 * The shapes, said in words.
 *
 * "9:16" is a photographer's word, and a seller choosing between five of
 * them is being asked to do arithmetic about something they could simply be
 * shown. The control draws each one at its own proportions; this is the
 * other half — the sentence saying where the picture is going, which is the
 * decision actually being made.
 */
describe('what each shape is for', () => {
  it('has an answer for every shape a seller can pick', () => {
    for (const a of ASPECTS) {
      const use = ASPECT_USE[a];
      expect(use, a).toBeTruthy();
      expect(use.label.length, a).toBeGreaterThan(2);
      expect(use.note.length, a).toBeGreaterThan(15);
    }
  });

  it('draws each one at its own proportions', () => {
    for (const a of ASPECTS) {
      const [w, h] = a.split(':').map(Number) as [number, number];
      const use = ASPECT_USE[a];
      // The glyph is small and integral, so it cannot be exact — but it has
      // to be near enough that nobody mistakes tall for wide.
      expect(Math.abs(use.w / use.h - w / h), `${a} glyph is ${use.w}×${use.h}`).toBeLessThan(0.12);
      // And big enough to see at a glance.
      expect(Math.min(use.w, use.h), a).toBeGreaterThanOrEqual(10);
    }
  });

  it('names the place a merchant is posting, not the maths', () => {
    // The whole point: a seller picks by where it is going.
    expect(`${ASPECT_USE['9:16'].note}`).toMatch(/status|stor(y|ies)|tiktok/i);
    expect(`${ASPECT_USE['1:1'].note}`).toMatch(/feed|instagram|facebook|whatsapp/i);
    expect(`${ASPECT_USE['16:9'].note}`).toMatch(/youtube|banner|slide/i);
  });

  it('gives each shape a different label, or the choice reads as a repeat', () => {
    expect(new Set(ASPECTS.map((a) => ASPECT_USE[a].label)).size).toBe(ASPECTS.length);
  });
});
