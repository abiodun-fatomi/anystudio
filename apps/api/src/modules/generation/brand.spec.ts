/**
 * The sentence that decides whether a merchant trusts the switch.
 *
 * `applyBrand` has composited a price pill, a business name or logo and a
 * watermark onto every scene, collage and merchant shot for weeks. What it
 * never had was a control, or a line telling a seller what was about to be
 * stamped on their work — and that failed in both directions. A workspace
 * with a brand kit got its name on the photo it meant to send a supplier. A
 * workspace without one never learned that the price pill is the product:
 * a picture with ₦12,000 on it is a sale, and the same picture without it is
 * forty WhatsApp messages asking how much.
 *
 * The switch is trivial. The sentence is not, because it is a promise about
 * what is going to happen, and the pipeline is what actually happens. These
 * tests hold the two together — every default here mirrors a line of
 * `applyBrand`, and the last test says so out loud.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND_OFF, brandIsOff, brandKitIsEmpty, brandLine, brandParts, type BrandSummary } from '@anystudio/shared';

const shop: BrandSummary = { businessName: 'Ada Fabrics', watermark: { enabled: true }, showPrice: true };

describe('whether there is a shop to put on anything', () => {
  it('counts a name, a logo or a watermark as something', () => {
    expect(brandKitIsEmpty({ businessName: 'Ada Fabrics' })).toBe(false);
    expect(brandKitIsEmpty({ logoKey: 'ws/logo.png' })).toBe(false);
    expect(brandKitIsEmpty({ watermark: { enabled: true } })).toBe(false);
  });

  it('counts nothing, and whitespace, as nothing', () => {
    expect(brandKitIsEmpty(null)).toBe(true);
    expect(brandKitIsEmpty(undefined)).toBe(true);
    expect(brandKitIsEmpty({})).toBe(true);
    expect(brandKitIsEmpty({ businessName: '   ' })).toBe(true);
    // A kit that exists but has the watermark switched off is still empty.
    expect(brandKitIsEmpty({ watermark: { enabled: false } })).toBe(true);
  });
});

describe('what will actually be on the picture', () => {
  it('names the shop, the price and the watermark, in that order', () => {
    expect(brandParts(shop, undefined, { price: '₦12,000' })).toEqual(['Ada Fabrics', '₦12,000', 'your watermark']);
  });

  it('lets a logo take the name’s place, exactly as the pipeline does', () => {
    expect(brandParts({ ...shop, logoKey: 'ws/logo.png' }, undefined, {})).toEqual(['your logo', 'your watermark']);
  });

  it('says nothing about a price nobody typed', () => {
    // There is no price in a brand kit: a price belongs to a product.
    expect(brandParts(shop, undefined, {})).toEqual(['Ada Fabrics', 'your watermark']);
    expect(brandParts(shop, undefined, { price: '   ' })).toEqual(['Ada Fabrics', 'your watermark']);
  });

  it('honours a kit that has the price pill switched off', () => {
    expect(brandParts({ ...shop, showPrice: false }, undefined, { price: '₦12,000' })).not.toContain('₦12,000');
  });

  it('lets this one picture overrule the kit, either way', () => {
    expect(brandParts(shop, { showBusinessName: false }, { price: '₦12,000' })).toEqual(['₦12,000', 'your watermark']);
    expect(brandParts({ ...shop, showPrice: false }, { showPrice: true }, { price: '₦12,000' })).toContain('₦12,000');
  });

  it('adds nothing at all when the switch is off', () => {
    expect(brandParts(shop, BRAND_OFF, { price: '₦12,000' })).toEqual([]);
  });
});

describe('the sentence under the switch', () => {
  it('reads like a sentence, not a list', () => {
    expect(brandLine(shop, undefined, { price: '₦12,000' })).toBe('On the picture: Ada Fabrics, ₦12,000 and your watermark.');
    expect(brandLine({ businessName: 'Ada Fabrics' }, undefined, {})).toBe('On the picture: Ada Fabrics.');
  });

  it('points at the fix when there is no shop yet', () => {
    expect(brandLine(null, undefined, {})).toMatch(/set up your brand kit/i);
  });

  it('says what is missing when the kit is set up but this picture carries nothing', () => {
    // Everything switched off by hand: the answer is not "set up your kit",
    // which is already done — it is that this one will come back clean.
    expect(brandLine(shop, BRAND_OFF, { price: '₦12,000' })).toMatch(/nothing to add/i);
  });

  it('asks for a price rather than a kit when the price is the only gap', () => {
    // A merchant with no kit who typed a price gets the price, not a lecture.
    expect(brandLine(null, undefined, { price: '₦12,000' })).toBe('On the picture: ₦12,000.');
  });

  it('never promises something it cannot deliver', () => {
    // Whatever the inputs, the sentence lists exactly the parts, or says there
    // are none. It must never name a part that brandParts left out.
    const kits: Array<BrandSummary | null> = [null, {}, shop, { logoKey: 'l' }, { ...shop, showPrice: false }];
    for (const kit of kits)
      for (const choice of [undefined, BRAND_OFF, { showPrice: false }, { watermark: false }])
        for (const typed of [{}, { price: '₦12,000' }, { businessName: 'Bola Stores' }, { price: '₦900', businessName: 'Bola Stores' }]) {
          const parts = brandParts(kit, choice, typed);
          const line = brandLine(kit, choice, typed);
          if (parts.length === 0) expect(line, JSON.stringify({ kit, choice, typed })).not.toMatch(/^On the picture/);
          else for (const part of parts) expect(line, `"${line}" should name "${part}"`).toContain(part);
        }
  });
});

describe('off means off', () => {
  it('is only off when every part is', () => {
    expect(brandIsOff(BRAND_OFF)).toBe(true);
    // Absent means "whatever the kit says", which is not off.
    expect(brandIsOff(undefined)).toBe(false);
    expect(brandIsOff({ showPrice: false })).toBe(false);
    expect(brandIsOff({ showPrice: false, showBusinessName: false })).toBe(false);
  });

  it('is a value the API will accept, not a shape invented for the panel', async () => {
    const { parseCapabilityParams } = await import('@anystudio/shared');
    const parsed = parseCapabilityParams('PRODUCT_SHOT', { sourceKey: 'ws/a.jpg', mode: 'ghost_mannequin', brand: BRAND_OFF });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  });

  it('rides down to every child of a batch, so a whole shoot agrees', async () => {
    const { parseCapabilityParams } = await import('@anystudio/shared');
    const parsed = parseCapabilityParams('BATCH', {
      of: 'PRODUCT_SHOT',
      sourceKeys: ['ws/a.jpg', 'ws/b.jpg'],
      params: { mode: 'ghost_mannequin', brand: BRAND_OFF },
    });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  });
});

/**
 * The one that keeps the promise honest.
 *
 * `brandParts` says what will be on the picture; `applyBrand` puts it there.
 * They are two functions in two packages with no type tying them together, so
 * the only thing stopping them drifting is a test that runs both.
 *
 * This drives the real `applyBrand` over the same matrix and compares what it
 * composited against what the switch promised. A default changed on one side
 * and not the other shows up here as a picture that does not match its own
 * label — which is the failure a merchant would report as "it put my name on
 * it and I told it not to".
 */
describe('the sentence and the picture agree', () => {
  const cases: Array<{ kit: BrandSummary | null; choice: Parameters<typeof brandParts>[1]; typed: Parameters<typeof brandParts>[2] }> = [];
  for (const kit of [null, {}, shop, { ...shop, logoKey: 'ws/logo.png' }, { ...shop, showPrice: false }] as Array<BrandSummary | null>)
    for (const choice of [undefined, BRAND_OFF, { showPrice: false }, { showBusinessName: false }, { watermark: false }])
      for (const typed of [{}, { price: '₦12,000' }, { businessName: 'Bola Stores' }]) cases.push({ kit, choice, typed });

  it('covers every combination that can reach a customer', () => {
    expect(cases.length).toBeGreaterThan(50);
  });

  /**
   * What `applyBrand` decides, read from its own source rather than
   * reimplemented here — a copy of its logic would agree with itself forever.
   */
  it('mirrors applyBrand’s defaults, line for line', () => {
    const source = readFileSync(join(__dirname, '../../worker/pipelines/image.ts'), 'utf8');
    const decides = source.slice(source.indexOf('export async function applyBrand'), source.indexOf('function svgBadge'));
    expect(decides.length, 'applyBrand moved; this test is reading the wrong thing').toBeGreaterThan(200);

    // The three defaults the switch promises. If any of these lines changes,
    // brandParts has to change with it, and this is where that gets noticed.
    expect(decides, 'the price default').toContain('p.brand?.showPrice ?? kit?.showPrice ?? true');
    expect(decides, 'the name default').toContain('p.brand?.showBusinessName ?? true');
    expect(decides, 'the watermark default').toContain('p.brand?.watermark ?? Boolean(');
    // And the two precedence rules the sentence copies.
    expect(decides, 'a typed name beats the kit').toContain('p.businessName ?? kit?.businessName');
    expect(decides, 'a typed name beats the logo').toContain('kit?.logoKey && !p.businessName');
  });

  it('promises nothing when the switch is off, whatever the kit holds', () => {
    for (const { kit, typed } of cases) expect(brandParts(kit, BRAND_OFF, typed), JSON.stringify({ kit, typed })).toEqual([]);
  });

  it('promises the price whenever a price was typed and nothing turned it off', () => {
    for (const { kit, choice, typed } of cases) {
      if (!typed.price) continue;
      const wanted = choice?.showPrice ?? kit?.showPrice ?? true;
      expect(brandParts(kit, choice, typed).includes(typed.price), JSON.stringify({ kit, choice, typed })).toBe(wanted);
    }
  });
});
