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
  },
  ghost_mannequin: {
    label: 'Ghost mannequin',
    note: 'The garment holding its shape, with the mannequin removed.',
    hint: 'The catalogue look every marketplace prefers for clothing.',
    forClothes: true,
    costCode: 'image.product_shot',
  },
  flat_lay: {
    label: 'Flat lay',
    note: 'Laid flat and square on a clean surface, shot from above.',
    hint: 'Tidies a photo taken on a bed or a floor.',
    forClothes: true,
    costCode: 'image.product_shot',
  },
  ironing: {
    label: 'Press it',
    note: 'Creases and wrinkles taken out of fabric.',
    hint: 'For anything photographed straight out of a bag.',
    forClothes: true,
    costCode: 'image.product_shot',
  },
  beautify: {
    label: 'Make it studio',
    note: 'A phone photo cleaned up into a studio shot.',
    hint: 'Lighting, colour and sharpness, without changing the product.',
    forClothes: false,
    costCode: 'image.product_shot',
  },
  recolor: {
    label: 'Another colour',
    note: 'The same item in a colour you have in stock.',
    hint: 'Say which part, or leave it and the whole item changes.',
    forClothes: false,
    costCode: 'image.product_shot',
  },
  retouch: {
    label: 'Remove something',
    note: 'A hand, a hanger, a price tag, a stray object.',
    hint: 'Say what should go.',
    forClothes: false,
    costCode: 'image.product_shot',
  },
  expand: {
    label: 'Show more room',
    note: 'The frame widened, with the surroundings continued.',
    hint: 'For a photo cropped too tight for a Status or a banner.',
    forClothes: false,
    costCode: 'image.product_shot',
  },
} as const;
export type ProductMode = keyof typeof PRODUCT_MODES;
export const PRODUCT_MODE_KEYS = Object.keys(PRODUCT_MODES) as ProductMode[];
export const productMode = (k: string | null | undefined) => (k && k in PRODUCT_MODES ? PRODUCT_MODES[k as ProductMode] : undefined);
/** What a mode costs. A merchant sees this before anything is charged. */
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
 * How many reference photos of the same product help.
 *
 * This is the lesson from every vendor that does this well: when a model has
 * to keep a product exact, MORE ANGLES beat a sterner prompt. A generation
 * that drifts is not a reason to refuse and refund — it is a reason to ask
 * the merchant for the back of the bag.
 */
export const PRODUCT_REFERENCE_ANGLES = { max: 3, helpfulFrom: 1 } as const;
