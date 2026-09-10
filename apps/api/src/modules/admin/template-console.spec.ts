import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { TemplateCreateDto, TemplatePatchDto, TemplateThumbnailDto } from './admin.dto';

const create = (over: Record<string, unknown> = {}) =>
  Object.assign(new TemplateCreateDto(), {
    code: 'furniture_living_warm',
    name: 'Warm living room',
    note: 'Oak floor.',
    category: 'furniture',
    kind: 'scene',
    prompt: 'A warm living room with soft morning light. No people, no text.',
    colors: ['#EFE4D6', '#D8C4AC'],
    ink: 'dark',
    reason: 'Adding the December set',
    ...over,
  });

describe('adding a template from the console', () => {
  it('accepts a complete one', async () => {
    expect(await validate(create())).toEqual([]);
  });

  it.each(['Furniture_Living', 'furniture living', 'furniture/living', '../escape', 'ab', 'x'.repeat(61), 'furniture.living'])(
    'refuses the code %s, because it becomes a storage key',
    async (code) => {
      // `templates/<code>.webp`. A slash, a dot or a traversal segment would
      // let a template address an object outside the catalogue prefix.
      expect((await validate(create({ code }))).length, code).toBeGreaterThan(0);
    },
  );

  it('refuses a category the shared list does not know', async () => {
    expect((await validate(create({ category: 'menswear' }))).length).toBeGreaterThan(0);
    expect(await validate(create({ category: 'general' }))).toEqual([]);
  });

  it('refuses anything but a scene or a cut', async () => {
    expect((await validate(create({ kind: 'video' }))).length).toBeGreaterThan(0);
  });

  it.each([['#fff'], ['EFE4D6'], ['rgb(1,2,3)'], ['#EFE4D6AA']])('refuses the fallback colour %s', async (colour) => {
    // The tile interpolates these straight into a CSS gradient.
    expect((await validate(create({ colors: [colour] }))).length, colour).toBeGreaterThan(0);
  });

  it('takes one colour or two and no more, because a tile is a flat fill or a two-stop gradient', async () => {
    expect(await validate(create({ colors: ['#EFE4D6'] }))).toEqual([]);
    expect((await validate(create({ colors: [] }))).length).toBeGreaterThan(0);
    expect((await validate(create({ colors: ['#EFE4D6', '#D8C4AC', '#111111'] }))).length).toBeGreaterThan(0);
  });

  it('always demands a reason, because every catalogue write is on the record', async () => {
    expect((await validate(create({ reason: 'x' }))).length).toBeGreaterThan(0);
    expect((await validate(create({ reason: undefined }))).length).toBeGreaterThan(0);
  });
});

describe('changing a template from the console', () => {
  it('takes a reason and nothing else', async () => {
    // Every field optional: retiring a template and rewording one are the
    // same endpoint, and neither should have to resend the other's values.
    expect(await validate(Object.assign(new TemplatePatchDto(), { reason: 'Retiring — comes out muddy' }))).toEqual([]);
    expect(await validate(Object.assign(new TemplatePatchDto(), { active: false, reason: 'Retiring — comes out muddy' }))).toEqual([]);
  });

  it('tells a cleared keyword list apart from an unmentioned one', async () => {
    // `@ValidateIf` rather than `@IsOptional`, so an empty string reaches the
    // service as a deliberate clear instead of being treated as absent.
    expect(await validate(Object.assign(new TemplatePatchDto(), { keywords: '', reason: 'Dropping the search words' }))).toEqual([]);
  });

  it('still refuses a bad category or kind on a patch', async () => {
    expect((await validate(Object.assign(new TemplatePatchDto(), { category: 'menswear', reason: 'Recategorising' }))).length).toBeGreaterThan(0);
    expect((await validate(Object.assign(new TemplatePatchDto(), { kind: 'video', reason: 'Changing kind' }))).length).toBeGreaterThan(0);
  });
});

describe('asking for somewhere to put a render', () => {
  const thumb = (over: Record<string, unknown> = {}) =>
    Object.assign(new TemplateThumbnailDto(), { mime: 'image/webp', bytes: 240_000, reason: 'Uploading the render', ...over });

  it('accepts the three image types the picker can draw', async () => {
    for (const mime of ['image/webp', 'image/jpeg', 'image/png']) expect(await validate(thumb({ mime })), mime).toEqual([]);
  });

  it('refuses anything that is not one of those', async () => {
    for (const mime of ['image/svg+xml', 'text/html', 'application/pdf', 'image/gif']) {
      expect((await validate(thumb({ mime }))).length, mime).toBeGreaterThan(0);
    }
  });

  it('caps the size, because the signature commits to a content length', async () => {
    expect((await validate(thumb({ bytes: 5_000_001 }))).length).toBeGreaterThan(0);
    expect((await validate(thumb({ bytes: 0 }))).length).toBeGreaterThan(0);
  });
});
