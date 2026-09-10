/**
 * The shots a merchant actually needs, named the way a merchant names them.
 *
 * "Restyle" and "Background replace" are engineering words. A person selling
 * clothes says "put it on a model", "show it without the mannequin", "lay it
 * flat", "the wrinkles". This catalogue is that vocabulary, and each entry
 * carries the vendor parameters that produce it, so the studio can offer a
 * tile with a picture on it instead of an empty prompt box.
 *
 * All of these are one vendor call to the same endpoint — the modes differ,
 * the plumbing does not. That is why they are ONE capability with a `mode`
 * rather than nine capabilities: the router, the queue and the adapter would
 * be identical nine times over, and the studio would gain nothing.
 *
 * THE PROMPT IS OPTIONAL ON EVERY MODE. A merchant with forty items should be
 * able to hand over a photo and get something good without writing anything.
 * Words are for the person who wants to steer, never a toll gate.
 */

export const PRODUCT_MODES = {
  on_model: {
    label: 'On a model',
    note: 'Your clothing worn by a person, without hiring one.',
    hint: 'Works from a flat photo, a hanger shot, or a mannequin.',
    forClothes: true,
    /** Priced above the rest: it is the shot a merchant would otherwise pay a model and a photographer for. */
    costCode: 'image.on_model',
    verified: true,
  },
  ghost_mannequin: {
    label: 'Ghost mannequin',
    note: 'The garment holding its shape, with the mannequin removed.',
    hint: 'The catalogue look every marketplace prefers for clothing.',
    forClothes: true,
    costCode: 'image.product_shot',
    verified: true,
  },
  flat_lay: {
    label: 'Flat lay',
    note: 'Laid flat and square on a clean surface, shot from above.',
    hint: 'Tidies a photo taken on a bed or a floor.',
    forClothes: true,
    costCode: 'image.product_shot',
    verified: true,
  },
  ironing: {
    label: 'Press it',
    note: 'Creases and wrinkles taken out of fabric.',
    hint: 'For anything photographed straight out of a bag.',
    forClothes: true,
    costCode: 'image.product_shot',
    verified: true,
  },
  beautify: {
    label: 'Enhance the photo',
    note: 'Gently improve brightness and colour while keeping the whole photo.',
    hint: 'No AI redraw or background removal. People, products and framing stay. Use Scene for a new background.',
    forClothes: false,
    costCode: 'image.product_shot',
    verified: true,
  },
  /**
   * The one a reseller needs most.
   *
   * Half the photos a Nigerian merchant starts from came from a supplier's
   * catalogue or a WhatsApp broadcast, and arrive with somebody else's
   * watermark, somebody else's price, or a phone number burned into the
   * corner. There is no polite way to post that. Taking the writing off is
   * not a nicety, it is the step between having a photo and being able to
   * use it.
   */
  text_removal: {
    label: 'Take the writing off',
    note: 'Watermarks, prices and phone numbers someone else put on the photo.',
    hint: 'Choose whether to remove writing added to the picture, writing that is really there, or both.',
    forClothes: false,
    costCode: 'image.product_shot',
    verified: true,
  },
  /**
   * The escape hatch. Every catalogue of named modes eventually meets a
   * merchant whose problem is not on the list — a hand in the frame, a
   * hanger, a crease in the wrong place — and the answer should be a
   * sentence, not a shrug.
   */
  edit: {
    label: 'Describe a change',
    note: 'Say what you want different and it is done.',
    hint: '"Remove the hanger", "make the shoes black", "take out the person on the left".',
    forClothes: false,
    costCode: 'image.product_shot',
    verified: true,
  },
  expand: {
    label: 'Show more room',
    note: 'The frame widened, with the surroundings continued.',
    hint: 'For a photo cropped too tight for a Status or a banner.',
    forClothes: false,
    costCode: 'image.product_shot',
    verified: true,
  },
} as const;
export type ProductMode = keyof typeof PRODUCT_MODES;
export const PRODUCT_MODE_KEYS = Object.keys(PRODUCT_MODES) as ProductMode[];

/**
 * The modes the studio actually offers.
 *
 * `verified: false` means the mode is written but its parameters are NOT in
 * the vendor's published API specification — they were inferred from the
 * app's own tool list, which is a guess, and a guess that reaches a paid
 * endpoint costs a customer credits to discover. Those stay out of the studio
 * until someone has run them against a live key and seen a picture come back.
 * Flipping one on is a one-word change here.
 */
/**
 * Modes where the product is meant to come back the same SHAPE it went in.
 *
 * This decides whether the fidelity check can refuse a result, and getting it
 * wrong is expensive in both directions.
 *
 * Press it and Make it studio hand back the same garment in the same pose
 * with the creases gone or the light fixed — a product that moved, changed
 * colour or grew a new label there is a failure, and the check catches it.
 *
 * On a model, Ghost mannequin and Flat lay are the opposite: the whole point
 * is that the garment is now draped on a body, inflated to a torso, or laid
 * out square. The pixels SHOULD be different. Measuring those against the
 * original and refusing what does not match would reject the good ones —
 * exactly the shots a merchant came here for. They are still measured, and
 * the score is logged, but it never refuses.
 *
 * Show more room keeps the original pixels and adds canvas around them, so
 * the check finds the product where it was pushed to and judges it there.
 */
export const KEEPS_GEOMETRY: readonly ProductMode[] = ['ironing', 'beautify', 'expand', 'text_removal', 'edit'];
/** Whether a refusal is fair for this mode, or would throw away a correct picture. */
export const judgesShape = (mode: ProductMode): boolean => KEEPS_GEOMETRY.includes(mode);

export const OFFERED_PRODUCT_MODES = PRODUCT_MODE_KEYS.filter((k) => PRODUCT_MODES[k].verified);
export const productMode = (k: string | null | undefined) => (k && k in PRODUCT_MODES ? PRODUCT_MODES[k as ProductMode] : undefined);
/** What a mode costs, before size is taken into account. */
export const productModeCostCode = (k: string | null | undefined): string => productMode(k)?.costCode ?? 'image.product_shot';

/**
 * Who wears it. The vendor ships a preset cast; a workspace can also save its
 * own — one photo of the seller, a friend, or a model they hired once — and
 * then every item in the catalogue is shot on the same familiar person, which
 * is worth more to a small shop than any stock face.
 */
export const MODEL_PRESETS = [
  'avery',
  'sam',
  'taylor',
  'kendall',
  'jordan',
  'casey',
  'alex',
  'maya',
  'reece',
  'lena',
  'julia',
  'jackson',
  'sophia',
  'emma',
  'ava',
  'zoe',
  'fiona',
] as const;
export type ModelPreset = (typeof MODEL_PRESETS)[number];

/**
 * How big the picture comes back.
 *
 * The vendor calls these standard, advanced and premium, which tells a seller
 * nothing and reads like a sales page. What they actually mean is roughly 1K,
 * 2K and 4K on the long side — so they are named here for what a merchant is
 * going to DO with the picture, and the resolution is stated rather than
 * implied. Bigger costs more and takes longer; a Status post does not want
 * either, which is why the default is the small one.
 *
 * Only the on-a-model shot takes this. The other modes have no such parameter
 * in the vendor's specification, and inventing one for them would send a key
 * nothing reads.
 */
export const SHOT_SIZES = {
  posting: { label: 'For posting', note: 'About 1K wide. Right for Status, Instagram and WhatsApp.', vendor: 'standard' },
  listing: { label: 'For listing', note: 'About 2K wide. Right for a marketplace listing or a small print.', vendor: 'advanced' },
  printing: { label: 'For printing', note: 'About 4K wide. Right for a banner or a poster. Slowest.', vendor: 'premium' },
} as const;
export type ShotSize = keyof typeof SHOT_SIZES;
export const SHOT_SIZE_KEYS = Object.keys(SHOT_SIZES) as ShotSize[];
/** Which modes the vendor will accept a size on. */
export const TAKES_SHOT_SIZE: readonly ProductMode[] = ['on_model'];

/**
 * What a shot costs, all in.
 *
 * A 4K render is more of the vendor's work than a 1K one, so it cannot be the
 * same price, and the difference is expressed as its own cost code rather
 * than as arithmetic here: every price in this product lives in one table an
 * operator can change without a deploy, and a multiplier hidden in code would
 * be the one price they could not.
 *
 * Only the on-a-model shot has sizes, so only it has the extra codes.
 */
export function productShotCostCode(mode: string | null | undefined, shotSize?: string | null): string {
  const base = productModeCostCode(mode);
  if (!mode || !(TAKES_SHOT_SIZE as readonly string[]).includes(mode)) return base;
  if (shotSize === 'listing') return `${base}.2k`;
  if (shotSize === 'printing') return `${base}.4k`;
  return base;
}

/** Where the shot is taken. 'random' lets the vendor choose, which is the right default for someone in a hurry. */
export const MODEL_SCENES = [
  'random',
  'studio',
  'coloredstudio',
  'concretestudio',
  'street',
  'businessdistrict',
  'cafe',
  'library',
  'bedroom',
  'beach',
  'pool',
  'tropical',
  'forest',
  'countryside',
  'mountain',
  'desert',
  'flowers',
  'sunset',
  'goldenlight',
  'nightlights',
  'latincity',
  'asiancity',
  'factory',
] as const;
export type ModelScene = (typeof MODEL_SCENES)[number];

export const MODEL_POSES = [
  'random',
  'standing',
  '34turn',
  'powerstance',
  'walkingforward',
  'handinpocket',
  'crossedarms',
  'back',
  'overtheshoulder',
  'seated',
  'adjustingclothing',
  'playfulspin',
] as const;
export type ModelPose = (typeof MODEL_POSES)[number];

/**
 * How the product meets the surface. Shown as pictures, never as words: no
 * one can tell "floating" from "hard" by reading it, and everyone can tell by
 * looking at two spheres.
 */
export const SHADOW_STYLES = {
  soft: { label: 'Soft', mode: 'ai.soft' },
  hard: { label: 'Hard', mode: 'ai.hard' },
  floating: { label: 'Floating', mode: 'ai.floating' },
  none: { label: 'None', mode: null },
} as const;
export type ShadowStyle = keyof typeof SHADOW_STYLES;

/** The vendor's frame names, from our aspect ratios. */
export const PRODUCT_SIZE_BY_ASPECT: Record<string, string> = {
  '1:1': 'SQUARE_HD',
  '4:5': 'PORTRAIT_HD_4_3',
  '3:4': 'PORTRAIT_HD_4_3',
  '9:16': 'PORTRAIT_HD_16_9',
  '16:9': 'LANDSCAPE_HD_16_9',
};

/**
 * What kind of writing to take off.
 *
 * The distinction is the vendor's and it is a real one. A supplier's
 * watermark was ADDED to the picture and should always go. The name on the
 * shop sign behind the product is part of the photograph, and removing it
 * may be exactly right (a rival's signage) or exactly wrong (the seller's
 * own). So it is a choice, phrased as the thing rather than the category.
 */
export const TEXT_KINDS = {
  artificial: { label: 'Added on top', note: 'Watermarks, prices, phone numbers — writing put onto the photo afterwards.', vendor: 'ai.artificial' },
  natural: { label: 'In the picture', note: 'Signs, labels and packaging that were really there when it was taken.', vendor: 'ai.natural' },
  all: { label: 'Everything', note: 'Both kinds. Check the result — a label you wanted may go with it.', vendor: 'ai.all' },
} as const;
export type TextKind = keyof typeof TEXT_KINDS;
export const TEXT_KIND_KEYS = Object.keys(TEXT_KINDS) as TextKind[];

/**
 * How many reference photos of the same product help.
 *
 * This is the lesson from every vendor that does this well: when a model has
 * to keep a product exact, MORE ANGLES beat a sterner prompt. A generation
 * that drifts is not a reason to refuse and refund — it is a reason to ask
 * the merchant for the back of the bag.
 */
// Four, because that is the vendor's own ceiling (`maxItems: 4`), and this is
// the one place where taking all it will accept is straightforwardly better
// for the merchant.
export const PRODUCT_REFERENCE_ANGLES = { max: 4, helpfulFrom: 1 } as const;
