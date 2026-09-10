import type { PresetSwatch } from './presets';

/**
 * Rooms and settings you pick by looking at a photograph of one.
 *
 * The preset catalogue next door answers "where should the product be?" with
 * a name and a colour chip. That works when the answer is a colour — "Plain
 * white", "Deep black" — and stops working the moment the answer is a room.
 * Nobody can tell a warm oak living room from a cool concrete one by reading
 * two gradient swatches, and a seller with a sofa to photograph is choosing
 * between rooms, not between colours.
 *
 * So a template carries a RENDERED EXAMPLE: the same prompt, run once against
 * a stock product, stored and served as the tile. The seller browses
 * photographs and taps the one that looks like the shop they wish they had.
 * That is the whole difference, and it is the reason this is a database table
 * and the presets are a TypeScript array — a photograph has to be produced,
 * stored, reviewed and replaced, and none of those are things a code deploy
 * should be in the middle of.
 *
 * Two more differences follow from the same place:
 *
 *   CATEGORY, NOT GROUP.  Presets group by setting (studio, surface, at
 *   home). Templates group by what is being SOLD, because that is the
 *   question a seller can answer instantly about their own item. Somebody
 *   with a dress does not know whether they want "on a surface"; they know
 *   they have a dress.
 *
 *   OPERATOR-OWNED.  Templates are added, reordered, retired and
 *   re-photographed from the staff console without a release. A seasonal set
 *   for December should not need a pull request.
 *
 * A template is still not a lock. Tapping one fills the fields and every word
 * it writes stays editable underneath, exactly like a preset.
 */

/**
 * What the seller is photographing.
 *
 * Deliberately the merchandise taxonomy a seller already uses to describe
 * their own shop, not an internal one: these are the words that appear in an
 * Instagram bio. `general` is the escape hatch for anything that does not
 * fit, and it is last on purpose — a chip nobody needs should not be the
 * first one they read.
 */
export const TEMPLATE_CATEGORIES = {
  dresses: { label: 'Dresses' },
  tops: { label: 'Tops' },
  bottoms: { label: 'Bottoms' },
  outerwear: { label: 'Outerwear' },
  accessories: { label: 'Accessories' },
  footwear: { label: 'Footwear' },
  bags: { label: 'Bags' },
  beauty: { label: 'Beauty' },
  food_drink: { label: 'Food & Drink' },
  furniture: { label: 'Furniture' },
  electronics: { label: 'Electronics' },
  general: { label: 'Everything else' },
} as const;

export type TemplateCategory = keyof typeof TEMPLATE_CATEGORIES;

export const TEMPLATE_CATEGORY_KEYS = Object.keys(TEMPLATE_CATEGORIES) as TemplateCategory[];

export function isTemplateCategory(value: unknown): value is TemplateCategory {
  return typeof value === 'string' && value in TEMPLATE_CATEGORIES;
}

/**
 * A template as the studio receives it.
 *
 * `thumbnailUrl` is a signed URL minted at the edge and good for minutes, not
 * a permanent address — the same rule every other object in the system
 * follows. It is null until an operator has produced the example render,
 * which is why `swatch` is not optional: a template with no photograph yet
 * still has to draw a tile, and it falls back to the gradient the presets
 * use. That fallback is what lets the catalogue ship before the photography
 * is finished, and lets one bad render be deleted without blanking a chip.
 */
export interface TemplateView {
  code: string;
  /** What a seller would call it. Never a capability name. */
  name: string;
  /** One line, shown under the tile and as its title. */
  note: string;
  category: TemplateCategory;
  /** Same meaning as a preset's: `cut` flattens onto a colour, `scene` asks a model for a setting. */
  kind: 'cut' | 'scene';
  /** Merged over whatever the seller already typed, so their own words survive a tap. */
  params: Record<string, unknown>;
  thumbnailUrl: string | null;
  swatch: PresetSwatch;
  keywords?: string;
}

/**
 * How many templates the panel shows before the door to the rest.
 *
 * Six rather than the looks field's four: these tiles are photographs, and a
 * photograph at tile size needs to be big enough to tell one room from
 * another, which means a wider tile and a row that would look thin at four.
 */
export const TEMPLATES_INLINE = 6;

/**
 * Templates matching what someone typed.
 *
 * Searched across the name, the sentence, the search words and the category
 * label, so "living room" finds the furniture scenes and "owambe" finds the
 * party ones. An empty query is everything, which is what the sheet opens on.
 */
export function searchTemplates(templates: readonly TemplateView[], query: string): TemplateView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...templates];
  const words = q.split(/\s+/);
  return templates.filter((t) => {
    const hay = `${t.name} ${t.note} ${t.keywords ?? ''} ${TEMPLATE_CATEGORIES[t.category].label}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The categories that actually have something in them, in catalogue order. */
export function templateCategoriesPresent(templates: readonly TemplateView[]): TemplateCategory[] {
  const seen = new Set(templates.map((t) => t.category));
  return TEMPLATE_CATEGORY_KEYS.filter((c) => seen.has(c));
}

/**
 * Where a template's example render lives.
 *
 * Under a reserved prefix with no workspace segment, because catalogue data
 * belongs to nobody: `MediaService.readUrl` refuses any key that does not
 * start with the caller's workspace id, which is exactly the protection we
 * want everywhere else and exactly wrong here. These are signed with
 * `signRead` instead, the same way the worker signs its own reads.
 */
export const TEMPLATE_ASSET_PREFIX = 'templates/';

export const templateThumbnailKey = (code: string, ext: 'webp' | 'jpg' | 'png'): string => `${TEMPLATE_ASSET_PREFIX}${code}.${ext}`;

/** A thumbnail must live under the reserved prefix — nothing else may be signed as catalogue art. */
export function isTemplateAssetKey(key: string): boolean {
  return key.startsWith(TEMPLATE_ASSET_PREFIX) && !key.includes('..') && key.length > TEMPLATE_ASSET_PREFIX.length;
}
