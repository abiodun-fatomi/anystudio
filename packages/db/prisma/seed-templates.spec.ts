import { describe, expect, it } from 'vitest';
import { TEMPLATE_CATEGORY_KEYS, isTemplateCategory } from '@anystudio/shared';
import { TEMPLATES, templateParams } from './seed-templates';

/**
 * The catalogue's content is the feature. A template with a broken category
 * lands in the escape-hatch chip, a scene with no prompt renders nothing, and
 * a duplicate code silently overwrites its twin on the next deploy — none of
 * which show up in a typecheck, and all of which reach a customer's picker.
 */
describe('the seeded template catalogue', () => {
  it('has a unique code for every row', () => {
    const codes = TEMPLATES.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('uses codes that are safe to put in a storage key', () => {
    // The code becomes `templates/<code>.webp`. A slash or a dot would let a
    // template address an object outside the catalogue prefix.
    for (const t of TEMPLATES) expect(t.code, t.code).toMatch(/^[a-z0-9_]{3,60}$/);
  });

  it('only uses categories the shared list knows', () => {
    for (const t of TEMPLATES) expect(isTemplateCategory(t.category), `${t.code} → ${t.category}`).toBe(true);
  });

  it('gives every scene something to render and every cut nothing to render', () => {
    for (const t of TEMPLATES) {
      if (t.kind === 'scene') expect(t.prompt.trim().length, t.code).toBeGreaterThan(40);
      else expect(templateParams(t).prompt, t.code).toBe('');
    }
  });

  it('never lets a cut carry a stale prompt into the panel', () => {
    // The studio decides cut-or-scene by looking at whether the prompt field
    // has words in it, so a cut MUST clear it rather than leave it alone.
    const cut = templateParams({ ...TEMPLATES[0]!, kind: 'cut' });
    expect(cut).toEqual({ background: '#FFFFFF', prompt: '' });
  });

  it('describes the setting and never the product', () => {
    // The seller's item is the one thing the model must not invent. A prompt
    // that names a product is a prompt inviting it to be redrawn, and the
    // fidelity loop will then reject the render it asked for.
    const forbidden = /\b(the product|the item|a dress|a shoe|a bag|a chair|a sofa|the garment)\b/i;
    for (const t of TEMPLATES) expect(forbidden.test(t.prompt), `${t.code}: ${t.prompt}`).toBe(false);
  });

  it('keeps people, lettering and brands out of every scene', () => {
    for (const t of TEMPLATES.filter((x) => x.kind === 'scene')) {
      expect(t.prompt, t.code).toMatch(/no people/i);
      expect(t.prompt, t.code).toMatch(/no text/i);
    }
  });

  it('names the light in every scene, because a composite without it reads as a cut-out on a picture', () => {
    const light = /(light|sun|daylight|lit|shadow)/i;
    for (const t of TEMPLATES.filter((x) => x.kind === 'scene')) expect(light.test(t.prompt), t.code).toBe(true);
  });

  it('gives every row a drawable fallback swatch', () => {
    for (const t of TEMPLATES) {
      expect(t.swatch.colors.length, t.code).toBeGreaterThan(0);
      for (const c of t.swatch.colors) expect(c, t.code).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('leaves room between sort values so a new template can be slotted in without renumbering', () => {
    for (const category of TEMPLATE_CATEGORY_KEYS) {
      const sorts = TEMPLATES.filter((t) => t.category === category)
        .map((t) => t.sort)
        .sort((a, b) => a - b);
      expect(new Set(sorts).size, category).toBe(sorts.length);
      for (let i = 1; i < sorts.length; i += 1) expect(sorts[i]! - sorts[i - 1]!, category).toBeGreaterThanOrEqual(10);
    }
  });

  it('fills the categories the picker offers, so no chip opens on nothing', () => {
    // A chip a seller taps to find an empty grid is worse than no chip.
    for (const category of TEMPLATE_CATEGORY_KEYS) {
      expect(
        TEMPLATES.filter((t) => t.category === category).length,
        `${category} has no templates — either seed some or take it out of TEMPLATE_CATEGORIES`,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps every note short enough to sit under a tile', () => {
    for (const t of TEMPLATES) {
      expect(t.name.length, t.code).toBeLessThanOrEqual(60);
      expect(t.note.length, t.code).toBeLessThanOrEqual(120);
    }
  });
});
