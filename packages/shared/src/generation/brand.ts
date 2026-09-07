/**
 * Whose shop is on the picture.
 *
 * The badge machinery has been complete for weeks — `applyBrand` composites
 * a price pill, the business name or logo, and a watermark onto every scene,
 * collage and merchant shot. What it never had was a switch, or a sentence
 * telling a seller what was about to be stamped on their work.
 *
 * That cuts both ways, and both ways are bad. A workspace with a brand kit
 * gets its name on every picture whether or not this one is going on Status
 * — including the photo they meant to send to a supplier. A workspace
 * without one gets nothing, and never learns that the price pill is why the
 * product exists: a picture with ₦12,000 on it is a sale, and a picture
 * without it is forty WhatsApp messages asking how much.
 *
 * So there is one control, and this is what stands behind it: a plain
 * sentence naming exactly what will appear. Not a preview that might lie,
 * not three checkboxes a merchant has to reason about — the words that are
 * going on the picture, before they spend a credit.
 *
 * The fine-grained settings stay on the Brand kit page, where they are set
 * once. This is the per-picture answer to one question: this one too?
 */

/** What the studio knows about a workspace's brand kit. A missing kit is `null`, not an empty object. */
export interface BrandSummary {
  businessName?: string | null;
  logoKey?: string | null;
  watermark?: { enabled?: boolean } | null;
  showPrice?: boolean;
}

/** The per-generation override. Absent means "whatever the kit says". */
export interface BrandChoice {
  showPrice?: boolean;
  showBusinessName?: boolean;
  watermark?: boolean;
}

/** Whether a kit has anything at all to put on a picture. */
export const brandKitIsEmpty = (kit: BrandSummary | null | undefined): boolean =>
  !kit || (!kit.businessName?.trim() && !kit.logoKey && !kit.watermark?.enabled);

/** Whether the studio has anything at all to offer this picture — kit or typed. */
export const nothingToBrand = (kit: BrandSummary | null | undefined, typed: BrandTyped = {}): boolean =>
  brandKitIsEmpty(kit) && !typed.price?.trim() && !typed.businessName?.trim();

/** What the merchant typed for THIS picture, as opposed to what the kit holds. */
export interface BrandTyped {
  /** There is no price in a kit: a price belongs to a product, not to a shop. */
  price?: string | null;
  /** A name typed here beats the kit's name AND its logo, exactly as the pipeline does it. */
  businessName?: string | null;
}

/**
 * What the badge will actually say, in the order it will say it.
 *
 * Every branch below mirrors one in `applyBrand`. That is the entire contract
 * of this function: if the two disagree, the switch is lying to a merchant
 * about their own work, which is worse than having no switch at all.
 */
export function brandParts(kit: BrandSummary | null | undefined, choice: BrandChoice | undefined, typed: BrandTyped = {}): string[] {
  const on = (k: keyof BrandChoice, fallback: boolean) => choice?.[k] ?? fallback;
  const parts: string[] = [];
  const typedName = typed.businessName?.trim();
  if (on('showBusinessName', true)) {
    // A name typed for this picture wins outright; only then does the logo
    // stand in for the kit's name.
    if (typedName) parts.push(typedName);
    else if (kit?.logoKey) parts.push('your logo');
    else if (kit?.businessName?.trim()) parts.push(kit.businessName.trim());
  }
  if (on('showPrice', kit?.showPrice ?? true) && typed.price?.trim()) parts.push(typed.price.trim());
  if (on('watermark', Boolean(kit?.watermark?.enabled))) parts.push('your watermark');
  return parts;
}

/**
 * The sentence under the switch.
 *
 * Three states, and each one has to be useful. Something to add: say what.
 * A kit set up but nothing this picture can carry: say what is missing, so
 * typing a price is an obvious next move. No kit at all: say so plainly,
 * because the answer is one page away and worth the trip.
 */
export function brandLine(kit: BrandSummary | null | undefined, choice: BrandChoice | undefined, typed: BrandTyped = {}): string {
  const nothingAnywhere = brandKitIsEmpty(kit) && !typed.price?.trim() && !typed.businessName?.trim();
  if (nothingAnywhere) return 'Set up your brand kit and your name goes on every picture.';
  const parts = brandParts(kit, choice, typed);
  if (parts.length === 0) return 'Nothing to add yet — type a price, or set up your brand kit.';
  const last = parts[parts.length - 1]!;
  const said = parts.length === 1 ? last : `${parts.slice(0, -1).join(', ')} and ${last}`;
  return `On the picture: ${said}.`;
}

/** Every part turned off, for a picture a merchant wants clean. */
export const BRAND_OFF: BrandChoice = { showPrice: false, showBusinessName: false, watermark: false };

/** Whether a choice means "leave my brand off this one". */
export const brandIsOff = (choice: BrandChoice | undefined): boolean =>
  choice?.showPrice === false && choice.showBusinessName === false && choice.watermark === false;
