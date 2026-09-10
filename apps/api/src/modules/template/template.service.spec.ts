import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TEMPLATE_ASSET_PREFIX, isTemplateAssetKey, templateThumbnailKey } from '@anystudio/shared';
import { TemplateService } from './template.service';
import type { MediaService } from '../media/media.service';

/**
 * The catalogue is public-ish data, so most of what could go wrong here is
 * cosmetic — except the signing, which is not. `signRead` skips the ownership
 * check that protects every other object in the system, so the prefix guard
 * is the only thing between this service and handing out a signature for an
 * arbitrary key. That is what the first block is about; the rest is making
 * sure a picker still opens when the data is imperfect.
 */

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  code: 'furniture_living_warm',
  name: 'Warm living room',
  note: 'Oak floor.',
  category: 'furniture',
  kind: 'scene',
  params: { prompt: 'A warm living room.' },
  thumbnailKey: null as string | null,
  swatch: { colors: ['#EFE4D6', '#D8C4AC'], ink: 'dark' },
  keywords: 'living room',
  active: true,
  sort: 10,
  operatorEdited: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function build(rows: ReturnType<typeof row>[], signRead = vi.fn(async (k: string) => `https://signed/${k}`)) {
  const db = { template: { findMany: vi.fn(async () => rows) } } as unknown as PrismaClient;
  const media = { signRead } as unknown as MediaService;
  return { service: new TemplateService(db, media), db, signRead };
}

describe('the template catalogue', () => {
  it('signs a thumbnail only when the key is catalogue art', async () => {
    // A key pointing anywhere but the reserved prefix must never be signed —
    // this method reaches a signer that does not check ownership.
    const rows = [
      row({ code: 'ok', thumbnailKey: templateThumbnailKey('ok', 'webp') }),
      row({ code: 'escaped', thumbnailKey: '../secrets/key.webp' }),
      row({ code: 'someone_elses', thumbnailKey: 'ffffffff-0000-0000-0000-000000000000/2026/01/output/private.webp' }),
      row({ code: 'traversal', thumbnailKey: `${TEMPLATE_ASSET_PREFIX}../../etc/passwd` }),
      row({ code: 'bare_prefix', thumbnailKey: TEMPLATE_ASSET_PREFIX }),
    ];
    const { service, signRead } = build(rows);
    const out = await service.list();

    expect(out.find((t) => t.code === 'ok')!.thumbnailUrl).toBe('https://signed/templates/ok.webp');
    for (const code of ['escaped', 'someone_elses', 'traversal', 'bare_prefix']) {
      expect(out.find((t) => t.code === code)!.thumbnailUrl).toBeNull();
    }
    // Not merely null in the output — never handed to the signer at all.
    expect(signRead).toHaveBeenCalledTimes(1);
    expect(signRead).toHaveBeenCalledWith('templates/ok.webp');
  });

  it('falls back to the gradient instead of failing when a signature cannot be minted', async () => {
    const signRead = vi.fn(async () => {
      throw new Error('storage is unreachable');
    });
    const { service } = build([row({ thumbnailKey: templateThumbnailKey('furniture_living_warm', 'webp') })], signRead);
    const [only] = await service.list();
    expect(only!.thumbnailUrl).toBeNull();
    expect(only!.swatch.colors).toEqual(['#EFE4D6', '#D8C4AC']);
  });

  it('puts a template whose category no longer exists in the escape hatch rather than dropping it', async () => {
    // An operator can retire a category from the shared list, or simply mis-type
    // one. Losing the template silently is worse than showing it in the wrong chip.
    const { service } = build([row({ category: 'menswear_2019' })]);
    const [only] = await service.list();
    expect(only!.category).toBe('general');
  });

  it('always produces a drawable swatch, however malformed the stored one', async () => {
    const { service } = build([
      row({ code: 'a', swatch: null }),
      row({ code: 'b', swatch: { colors: ['not a colour'], ink: 'dark' } }),
      row({ code: 'c', swatch: { colors: ['#112233', '#445566', '#778899'], ink: 'light' } }),
    ]);
    const out = await service.list();
    expect(out[0]!.swatch.colors.length).toBeGreaterThan(0);
    expect(out[1]!.swatch.colors).toEqual(['#EFEBE4']);
    // Two at most: the tile draws a single colour or a two-stop gradient.
    expect(out[2]!.swatch.colors).toEqual(['#112233', '#445566']);
    expect(out[2]!.swatch.ink).toBe('light');
  });

  it('serves the memo on a second read and drops it when the console writes', async () => {
    const { service, db } = build([row()]);
    await service.list();
    await service.list();
    expect(db.template.findMany).toHaveBeenCalledTimes(1);

    // Without this an operator retires a bad template, reloads, still sees it,
    // and concludes the console does not work.
    service.invalidate();
    await service.list();
    expect(db.template.findMany).toHaveBeenCalledTimes(2);
  });

  it('reads only the active rows, in catalogue order', async () => {
    const { service, db } = build([row()]);
    await service.list();
    expect(db.template.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: [{ category: 'asc' }, { sort: 'asc' }, { name: 'asc' }],
    });
  });
});

describe('catalogue asset keys', () => {
  it.each([
    ['templates/x.webp', true],
    ['templates/deep/x.webp', true],
    ['templates/', false],
    ['templates/../x', false],
    ['other/x.webp', false],
    ['', false],
  ])('%s is catalogue art: %s', (key, expected) => {
    expect(isTemplateAssetKey(key)).toBe(expected);
  });

  it('derives the key from the code alone, so a caller can never choose it', () => {
    expect(templateThumbnailKey('furniture_living_warm', 'webp')).toBe('templates/furniture_living_warm.webp');
    expect(templateThumbnailKey('a', 'jpg')).toBe('templates/a.jpg');
  });
});
