/**
 * What the product can make.
 *
 * A capability is the unit the router, the worker, the credit table and the
 * studio UI all agree on. It is deliberately NOT a provider or a model: the
 * customer asks for BACKGROUND_REMOVE, and which model answers is a config
 * row that an operator can change during an outage without a deploy.
 *
 * Every capability the product will ever have is declared here now, including
 * the ones that ship months from now (VOICEOVER, MUSIC, DUB, LIPSYNC). That is
 * what makes those releases additive — a new adapter and a new row — instead
 * of a refactor of everything that switches on this type.
 *
 * Kept here rather than imported from @prisma/client so the web app can use
 * it without pulling the database client into a browser bundle. The Prisma
 * enum `ProviderCapability` must stay in step; the API imports both, so CI's
 * typecheck catches drift.
 */

import { z } from 'zod';
import {
  productShotCostCode,
  MODEL_POSES,
  MODEL_PRESETS,
  MODEL_SCENES,
  PRODUCT_MODE_KEYS,
  PRODUCT_REFERENCE_ANGLES,
  SHADOW_STYLES,
  SHOT_SIZE_KEYS,
  TEXT_KIND_KEYS,
  type ProductMode,
  type ShadowStyle,
  type ShotSize,
  type TextKind,
} from './product-shots';

export const CAPABILITIES = [
  'IMAGE_GENERATE',
  'IMAGE_EDIT',
  'BACKGROUND_REMOVE',
  'BACKGROUND_REPLACE',
  'RELIGHT',
  'UPSCALE',
  'COLLAGE',
  'PRODUCT_SHOT',
  'BATCH',
  'IMAGE_TO_VIDEO',
  'VIDEO_STITCH',
  'TEXT_GENERATE',
  'VOICEOVER',
  'MUSIC',
  'DUB',
  'LIPSYNC',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
/** Customer-callable capabilities; stitching is an internal worker operation. */
export const PUBLIC_CAPABILITIES = CAPABILITIES.filter((c) => c !== 'VIDEO_STITCH');

export const isCapability = (v: unknown): v is Capability => typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// QUEUES
//
// Two weight classes. A four-minute video render must never sit in front of
// a caption that takes two seconds, and the only way to guarantee that is
// separate queues with separate concurrency — not priorities on one queue,
// which still share workers.
// ---------------------------------------------------------------------------

export const QUEUES = {
  fast: 'media.fast',
  heavy: 'media.heavy',
  local: 'media.local',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Long jobs that WAIT on a vendor. A slot here is a socket and a timer, not
 * a CPU: while a shot renders somewhere else the worker is idle, so this
 * queue is allowed many at once. Too few slots is what makes a four-shot ad
 * take twenty minutes on a machine doing nothing.
 */
const HEAVY: ReadonlySet<Capability> = new Set<Capability>(['IMAGE_TO_VIDEO', 'MUSIC', 'DUB', 'LIPSYNC']);
/** Long jobs that use OUR machine: ffmpeg stitching and sharp compositing pin a core, so only a couple run at once. */
const LOCAL: ReadonlySet<Capability> = new Set<Capability>(['VIDEO_STITCH', 'COLLAGE']);

/** Which queue carries a capability: our CPU, a vendor's, or neither. */
export const queueFor = (capability: Capability): QueueName => (LOCAL.has(capability) ? QUEUES.local : HEAVY.has(capability) ? QUEUES.heavy : QUEUES.fast);

/**
 * The only thing a queue job carries. The worker re-reads the row; a payload
 * that duplicated the row's fields would be a second source of truth that
 * could disagree with the first.
 */
export interface GenerationJob {
  generationId: string;
}

// ---------------------------------------------------------------------------
// PROGRESS
//
// The studio narrates a generation in stages ("Reading your photo" → "Placing
// it in the scene" → "Finishing"). The stages are emitted by the worker from
// real pipeline steps, never by a timer in the browser, which is why they are
// a shared type: the worker publishes them and the UI renders them.
// ---------------------------------------------------------------------------

export const GENERATION_STAGES = [
  'queued',
  'preparing', // inputs fetched, validated, cut out
  'routing', // choosing a provider
  'generating', // the provider is working
  'composing', // our own post-processing: composite, text, sizes, stitch
  'waiting', // a parent whose shots are rendering; it holds no worker while it waits
  'storing', // outputs written to storage
  'done',
  'failed',
] as const;
export type GenerationStage = (typeof GENERATION_STAGES)[number];

/** What the API streams to the studio for one generation. */
export type GenerationEvent =
  | { type: 'stage'; generationId: string; stage: GenerationStage; progress: number; detail?: string; at: string }
  | { type: 'output'; generationId: string; output: GenerationOutput; at: string }
  | { type: 'done'; generationId: string; status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'; balance?: number; at: string };

/** Redis channel a generation's events are published on. */
export const generationChannel = (generationId: string): string => `gen:${generationId}:events`;

// ---------------------------------------------------------------------------
// INPUTS AND OUTPUTS
//
// Media is referenced by storage object key, never by URL. URLs expire, differ
// per environment and would pin the product to one storage host forever.
// ---------------------------------------------------------------------------

/** A storage object key: {workspaceId}/{yyyy}/{mm}/{generationId}/{role}-{n}.{ext} */
export const objectKey = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[A-Za-z0-9/_.-]+$/);

export const ASPECTS = ['1:1', '4:5', '9:16', '16:9', '3:4'] as const;
export type Aspect = (typeof ASPECTS)[number];

/**
 * What each shape is FOR.
 *
 * "9:16" is a photographer's word. A seller deciding between five of them is
 * being asked to do arithmetic about a thing they could simply be shown, and
 * the honest answer to "what does 9:16 look like" is a shape — which fits
 * inside the button, so nobody has to open anything to find out.
 *
 * `w` and `h` draw that shape at the size the control has room for; the note
 * says where the picture is going, because that is the decision actually
 * being made.
 */
export const ASPECT_USE: Record<Aspect, { label: string; note: string; w: number; h: number }> = {
  '1:1': { label: 'Square', note: 'Instagram and Facebook feed, WhatsApp display picture.', w: 16, h: 16 },
  '4:5': { label: 'Tall post', note: 'The tallest a feed post can be — takes up the most screen.', w: 14, h: 17 },
  '9:16': { label: 'Full screen', note: 'WhatsApp Status, Instagram and Facebook Stories, TikTok.', w: 11, h: 19 },
  '16:9': { label: 'Wide', note: 'YouTube, a website banner, a slide.', w: 20, h: 11 },
  '3:4': { label: 'Portrait', note: 'A little taller than square. Marketplace listings.', w: 15, h: 20 },
};

/**
 * A multi-shot video, by shot count: how long each shot runs (the models make
 * 5 or 8 seconds a call) and what the whole is priced under. One reel is a
 * single 5–8 s shot; everything longer is a plan of shots stitched by us,
 * up to a minute.
 */
export const AD_PLANS = {
  2: { seconds: 15, durations: [8, 8], costCode: 'video.ad_15s' },
  4: { seconds: 30, durations: [8, 8, 8, 5], costCode: 'video.ad_30s' },
  6: { seconds: 45, durations: [8, 8, 8, 8, 8, 5], costCode: 'video.ad_45s' },
  8: { seconds: 60, durations: [8, 8, 8, 8, 8, 8, 8, 5], costCode: 'video.ad_60s' },
} as const;
export type AdShots = keyof typeof AD_PLANS;
export const adPlan = (shots: number) => (AD_PLANS as Record<number, (typeof AD_PLANS)[AdShots] | undefined>)[shots];

/**
 * Several photos in one picture — the post a seller makes when one photo is
 * not the whole story: the bag from three angles, the five colours in stock,
 * the plate before and after.
 *
 * Each layout says how many photos it is FOR, so the studio can offer the
 * ones that suit what has been picked instead of letting someone choose a
 * before-and-after with five photos in hand. `auto` is what the panel starts
 * on: the pipeline picks by the count.
 */
export const COLLAGE_LAYOUTS = {
  auto: { label: 'Choose for me', min: 2, max: 9, note: 'The tidiest arrangement for however many photos you picked.' },
  grid: { label: 'Even grid', min: 2, max: 9, note: 'Equal tiles. Best for a set — colours, sizes, a range.' },
  hero: { label: 'One big, rest below', min: 3, max: 9, note: 'The first photo leads; the others support it.' },
  row: { label: 'Side by side', min: 2, max: 4, note: 'A single row. Best for two or three.' },
  stack: { label: 'Stacked', min: 2, max: 4, note: 'One above the other. Good for a tall Status or Story.' },
  before_after: { label: 'Before and after', min: 2, max: 2, note: 'Two photos, labelled, with a divider between them.' },
} as const;
export type CollageLayout = keyof typeof COLLAGE_LAYOUTS;
export const COLLAGE_MIN_PHOTOS = 2;
export const COLLAGE_MAX_PHOTOS = 9;
/** The layouts that can hold this many photos, in the order the studio offers them. */
export const collageLayoutsFor = (count: number): CollageLayout[] =>
  (Object.keys(COLLAGE_LAYOUTS) as CollageLayout[]).filter((k) => count >= COLLAGE_LAYOUTS[k].min && count <= COLLAGE_LAYOUTS[k].max);

export const EXPORT_SIZES = {
  feed_square: { aspect: '1:1', width: 1080, height: 1080 },
  feed_portrait: { aspect: '4:5', width: 1080, height: 1350 },
  story: { aspect: '9:16', width: 1080, height: 1920 },
  landscape: { aspect: '16:9', width: 1920, height: 1080 },
  marketplace: { aspect: '1:1', width: 1200, height: 1200 },
} as const;
export type ExportSize = keyof typeof EXPORT_SIZES;

export interface GenerationOutput {
  /** Storage key of the file. */
  key: string;
  /** What it is: the branded image, a size variant, the reel, the caption set, a song's preview clip. */
  role: 'image' | 'variant' | 'video' | 'audio' | 'preview' | 'text' | 'thumb' | 'mask';
  mime: string;
  /**
   * The full song before it is paid for. A locked output's key points into
   * the workspace's vault prefix, which the API refuses to sign; unlocking
   * copies it out and clears this.
   */
  locked?: boolean;
  bytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  /** For variants: which export size this is. */
  size?: ExportSize;
  /** For text outputs, the content inline — small enough to carry. */
  text?: unknown;
}

// ---------------------------------------------------------------------------
// PARAMETERS — one schema per capability
//
// The API validates a request against these; the studio renders its controls
// from them; the worker trusts them. Adding a capability's controls to the UI
// is adding fields here, not writing a form.
// ---------------------------------------------------------------------------

const brandOverrides = z
  .object({
    showPrice: z.boolean().optional(),
    showBusinessName: z.boolean().optional(),
    watermark: z.boolean().optional(),
  })
  .optional();

/**
 * What can be done to a whole folder at once.
 *
 * Only the capabilities that take ONE photo and give back a picture. A song
 * has no folder; a collage is already many photos in one; an ad is a plan.
 */
export const BATCHABLE = ['PRODUCT_SHOT', 'BACKGROUND_REMOVE', 'BACKGROUND_REPLACE', 'RELIGHT', 'UPSCALE', 'IMAGE_EDIT'] as const;
export type BatchableCapability = (typeof BATCHABLE)[number];
export const isBatchable = (c: string): c is BatchableCapability => (BATCHABLE as readonly string[]).includes(c);
/** How many photos one batch may carry. The children are ordinary jobs, so the ceiling is patience, not throughput. */
export const BATCH_MAX = 100;

/** The ad shapes a seller picks between. The planner reads them; so does the single reel. */
export const AD_FORMATS = ['reveal', 'benefits', 'before_after', 'unboxing', 'price_drop', 'ugc'] as const;
export type AdFormat = (typeof AD_FORMATS)[number];

/**
 * What each ad format looks like as a single reel.
 *
 * A multi-shot ad has a planner: it is handed the format's brief and writes
 * a prompt per shot, and the seller's own words were always optional
 * direction on top. A one-shot reel had no such help — it sent whatever was
 * typed straight to the video model — which is why the prompt was required
 * everywhere, and why a seller who just wanted a price-drop reel had to
 * invent a camera move first.
 *
 * These are that missing half: one sentence of direction per format, good
 * enough to make a reel worth posting with nothing typed at all. A seller
 * who does have words still overrules them.
 */
export const REEL_BRIEF: Record<AdFormat, string> = {
  reveal: 'Start close on a detail and pull slowly back until the whole product is in frame, settling on it.',
  benefits: 'A slow, even push-in on the product, holding steady long enough to read it.',
  before_after: 'A slow tilt across the product, ending settled and square on it.',
  unboxing: 'Hands lift the product into frame and turn it gently, as if just opened.',
  price_drop: 'An energetic orbit around the product with light sweeping across it, ending square on.',
  ugc: 'Handheld, as if filmed on a phone: a small drift and refocus, natural light, nothing staged.',
};

export const capabilityParams = {
  IMAGE_GENERATE: z.object({
    /** Explicit intent for quality routing; never inferred from prompt keywords. */
    useCase: z.enum(['design', 'photography']).optional(),
    prompt: z.string().min(3).max(2000),
    aspect: z.enum(ASPECTS).default('1:1'),
    style: z.string().max(200).optional(),
    // Neither enabled image provider supports a true negative prompt. Reject
    // it explicitly instead of displaying a control that is silently ignored.
    negativePrompt: z.undefined({ invalid_type_error: 'Negative prompts are not supported by the available image models.' }).optional(),
    count: z.number().int().min(1).max(4).default(1),
  }),
  IMAGE_EDIT: z.object({
    useCase: z.enum(['design', 'photography']).optional(),
    sourceKey: objectKey,
    prompt: z.string().min(3).max(2000),
    /** Keep the product pixel-identical and only change its surroundings. */
    preserveProduct: z.boolean().default(true),
    aspect: z.enum(ASPECTS).default('1:1'),
    sizes: z.array(z.enum(Object.keys(EXPORT_SIZES) as [ExportSize, ...ExportSize[]])).default(['feed_square', 'story']),
    price: z.string().max(40).optional(),
    businessName: z.string().max(80).optional(),
    brand: brandOverrides,
  }),
  BACKGROUND_REMOVE: z.object({
    sourceKey: objectKey,
    /** Return a PNG with alpha, or flatten onto a colour. */
    background: z.union([z.literal('transparent'), z.string().regex(/^#[0-9a-fA-F]{6}$/)]).default('transparent'),
  }),
  BACKGROUND_REPLACE: z.object({
    sourceKey: objectKey,
    prompt: z.string().min(3).max(1000),
    shadow: z.boolean().default(true),
    relight: z.boolean().default(true),
    aspect: z.enum(ASPECTS).default('1:1'),
  }),
  RELIGHT: z.object({
    sourceKey: objectKey,
    prompt: z.string().max(500).optional(),
  }),
  UPSCALE: z.object({
    sourceKey: objectKey,
    factor: z.union([z.literal(2), z.literal(4)]).default(2),
  }),
  /**
   * Several photos in one. Entirely ours — sharp on our own box, no vendor,
   * no model — so it is quick, cheap and the same every time. The photos are
   * laid out in the order they were picked: the first one leads.
   */
  COLLAGE: z.object({
    sourceKeys: z.array(objectKey).min(COLLAGE_MIN_PHOTOS).max(COLLAGE_MAX_PHOTOS),
    layout: z.enum(Object.keys(COLLAGE_LAYOUTS) as [CollageLayout, ...CollageLayout[]]).default('auto'),
    aspect: z.enum(ASPECTS).default('1:1'),
    /** Space between the photos, as a share of the short side — 0 is edge to edge. */
    gap: z.number().int().min(0).max(48).default(14),
    /**
     * What happens when a photo and its tile are different shapes.
     *
     * 'fit' keeps the WHOLE photo and lets the background show around it.
     * 'fill' crops to the tile's edges. Fit is the default because a collage
     * is for showing photos, and a tall photo in a wide tile loses half its
     * subject to a crop nobody asked for — which is exactly what this used to
     * do, and why it now says so on the panel.
     */
    fit: z.enum(['fit', 'fill']).default('fit'),
    /** Where a filled tile crops from. Ignored when fitting the whole photo. */
    focus: z.enum(['auto', 'top', 'centre', 'bottom']).default('auto'),
    /** A hex colour behind the photos, or 'brand' for the brand kit's first colour. */
    background: z.union([z.literal('brand'), z.string().regex(/^#[0-9a-fA-F]{6}$/)]).default('#FFFFFF'),
    rounded: z.boolean().default(true),
    /** A word over each photo, in the same order — "Before", "After", a colour, a size. Blank entries are skipped. */
    labels: z.array(z.string().max(28)).max(COLLAGE_MAX_PHOTOS).default([]),
    sizes: z.array(z.enum(Object.keys(EXPORT_SIZES) as [ExportSize, ...ExportSize[]])).default(['feed_square', 'story']),
    price: z.string().max(40).optional(),
    businessName: z.string().max(80).optional(),
    brand: brandOverrides,
  }),
  /**
   * The shots a merchant needs, by name: on a model, ghost mannequin, flat
   * lay, pressed, studio, another colour, remove something, show more room.
   *
   * ONE capability rather than eight, because all eight are the same vendor
   * call with different fields — eight capabilities would be eight copies of
   * one adapter branch and eight places for the same bug.
   *
   * SPEED. These are synchronous, seconds-long calls, so they belong on the
   * fast queue. A shot that waits behind a four-minute video render is the
   * bug we already fixed once.
   *
   * ERRORS. Every requirement a mode has is checked HERE, before a credit is
   * spent — a recolour with no colour, a custom model with no photo, a
   * removal with nothing named. A request that cannot succeed should fail
   * free, in the browser, not after the vendor has been paid.
   */
  PRODUCT_SHOT: z
    .object({
      sourceKey: objectKey,
      mode: z.enum(PRODUCT_MODE_KEYS as [ProductMode, ...ProductMode[]]),
      /** Optional on every mode, always. Steering, never a toll gate. */
      prompt: z.string().max(600).optional(),
      aspect: z.enum(ASPECTS).default('1:1'),
      /**
       * More photos of the SAME product, from other angles. The single
       * cheapest quality lever there is: a model given the back of the bag
       * stops inventing one. Never required.
       */
      angleKeys: z.array(objectKey).max(PRODUCT_REFERENCE_ANGLES.max).default([]),
      /** on_model: a MODEL_PRESETS key, or 'custom' with a photo of the person. */
      model: z.string().max(40).optional(),
      modelPhotoKey: objectKey.optional(),
      scene: z.string().max(40).optional(),
      pose: z.string().max(40).optional(),
      /** text_removal: which writing goes — what was added on top, what was really there, or both. */
      textKind: z.enum(TEXT_KIND_KEYS as [TextKind, ...TextKind[]]).default('artificial'),
      /** beautify: the vendor tunes differently for food and for cars. */
      subject: z.enum(['auto', 'food', 'car']).default('auto'),
      /**
       * How big the picture comes back — roughly 1K, 2K or 4K. Only the
       * on-a-model shot takes it; elsewhere it is ignored rather than sent,
       * because the vendor has no such parameter on the other modes.
       */
      shotSize: z.enum(SHOT_SIZE_KEYS as [ShotSize, ...ShotSize[]]).default('posting'),
      shadow: z.enum(Object.keys(SHADOW_STYLES) as [ShadowStyle, ...ShadowStyle[]]).default('soft'),
      sizes: z.array(z.enum(Object.keys(EXPORT_SIZES) as [ExportSize, ...ExportSize[]])).default(['feed_square', 'story']),
      price: z.string().max(40).optional(),
      businessName: z.string().max(80).optional(),
      brand: brandOverrides,
    })
    .superRefine((v, ctx) => {
      const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
      // The prompt is optional on every mode but this one, where it IS the
      // instruction: a described edit with nothing described is a paid call
      // that can only come back unchanged.
      if (v.mode === 'edit' && !v.prompt?.trim()) fail('prompt', 'Say what you want changed.');
      if (v.mode === 'on_model' && v.model === 'custom' && !v.modelPhotoKey) fail('modelPhotoKey', 'Add a photo of the person who should wear it.');
      if (v.mode === 'on_model' && v.model && v.model !== 'custom' && !(MODEL_PRESETS as readonly string[]).includes(v.model))
        fail('model', `We do not have a model called "${v.model}".`);
      if (v.scene && !(MODEL_SCENES as readonly string[]).includes(v.scene)) fail('scene', `Unknown scene "${v.scene}".`);
      if (v.pose && !(MODEL_POSES as readonly string[]).includes(v.pose)) fail('pose', `Unknown pose "${v.pose}".`);
    }),
  /**
   * The same thing, to all of them.
   *
   * A merchant does not have one photo, they have forty — a rail of dresses, a
   * table of bags, a morning's shooting. Doing them one at a time is not a
   * smaller version of the job, it is a different job, and it is the reason a
   * studio gets abandoned halfway through a catalogue.
   *
   * A batch is a PARENT row holding the money and one CHILD per photo doing
   * the work. That machinery already exists for multi-shot ads; this reuses
   * it, minus the stitch at the end. The children run on the ordinary queues,
   * so a batch of forty is forty normal jobs — it cannot starve anything and
   * nothing has to be special-cased downstream.
   *
   * `params` is validated against `of`'s own schema before a credit moves, so
   * a batch of forty with one bad setting fails free rather than forty times.
   */
  BATCH: z
    .object({
      /** What to do to each photo. */
      of: z.enum(BATCHABLE as unknown as [BatchableCapability, ...BatchableCapability[]]),
      sourceKeys: z.array(objectKey).min(2).max(BATCH_MAX),
      /** The settings every photo gets. `sourceKey` is filled in per child. */
      params: z.record(z.unknown()).default({}),
    })
    .superRefine((v, ctx) => {
      // The child's own schema is the judge. A placeholder source stands in
      // for the one each child will really get.
      const probe = parseCapabilityParams(v.of, { ...v.params, sourceKey: v.sourceKeys[0] ?? 'ws/probe.jpg' });
      if (probe.ok) return;
      for (const [path, message] of Object.entries(probe.issues)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['params', ...path.split('.')], message });
    }),
  IMAGE_TO_VIDEO: z
    .object({
      sourceKey: objectKey,
      /**
       * Optional. Picking a format IS the brief — see REEL_BRIEF — and a
       * merchant who wants a price-drop reel should not have to describe a
       * camera move to get one. Filled in below when it is left blank, so
       * what was actually asked for is recorded on the row rather than
       * invented later by something downstream.
       */
      prompt: z.string().max(2000).optional(),
      durationSec: z.union([z.literal(5), z.literal(8)]).default(5),
      aspect: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
      /** Camera and motion hints the shot planner fills in. */
      motion: z.string().max(300).optional(),
      audio: z.boolean().default(false),
      /**
       * More than one shot makes this a PARENT: a plan is written, each shot is
       * its own CHILD generation rendered in parallel, and the parent stitches
       * them with captions, a bed and an end card. 1 = a single reel.
       */
      shots: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).default(1),
      /** The ad's shape — for the planner, and for the single reel's direction. */
      format: z.enum(AD_FORMATS).default('reveal'),
      /** Words for the end card; the price comes from the copy fields when present. */
      productName: z.string().max(120).optional(),
      price: z.string().max(40).optional(),
      details: z.string().max(800).optional(),
      /**
       * "Filmed by a customer" with a person actually talking to camera: the
       * first shot becomes a presenter — a stock face, or the seller from one
       * photo — saying a short testimonial in a catalogue voice or their own.
       * Only with `format: 'ugc'` and two or more shots.
       */
      presenter: z
        .object({
          kind: z.enum(['stock', 'photo']),
          /** A PRESENTERS key, for `stock`. */
          key: z.string().max(40).optional(),
          /** Their photo, for `photo`: a clear face, looking at the camera. */
          photoKey: objectKey.optional(),
          /** The person in the photo is them or gave permission; required for `photo`. */
          consent: z.boolean().optional(),
          /** A VoiceProfile key — a catalogue voice, or the workspace's own clone. Absent → the default voice. */
          voiceId: z.string().max(80).optional(),
          /** What they say, in the seller's words. Absent → the planner writes a testimonial. */
          script: z.string().max(600).optional(),
        })
        .optional(),
      /** Filled by the pipeline once the presenter segment is rendered, so a retry does not render it twice. */
      presenterClip: z.object({ key: objectKey, audioKey: objectKey, durationMs: z.number().int().min(500), script: z.string().max(1200) }).optional(),
      /** Shot-level fields the planner writes; a customer never sets them. */
      caption: z.string().max(120).optional(),
      shotIndex: z.number().int().min(0).max(7).optional(),
    })
    /**
     * A format with no words is a complete request, so it is completed here —
     * once, on the server, and recorded on the row. Filling it in downstream
     * would mean the seller could never see what was actually asked for, and
     * two code paths could disagree about it.
     */
    .transform((v) => ({ ...v, prompt: v.prompt?.trim() || REEL_BRIEF[v.format] })),
  VIDEO_STITCH: z
    .object({
      /** Ordered shot keys — each one an IMAGE_TO_VIDEO output. */
      shotKeys: z.array(objectKey).min(1).max(8),
      /**
       * Planned lengths for those keys. Vendors have different duration grids;
       * the media worker trims or pads each result to this timeline so a product
       * sold as a 30-second ad does not become 20 or 40 seconds after fallback.
       */
      shotDurationsMs: z.array(z.number().int().min(500).max(30_000)).min(1).max(8).optional(),
      /** Exact customer-facing runtime, including an end card when present. */
      targetDurationMs: z.number().int().min(500).max(120_000).optional(),
      /** Keep native audio from the video segments; absent/false produces silence. */
      preserveShotAudio: z.boolean().default(false),
      aspect: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
      captions: z.array(z.object({ text: z.string().max(200), fromMs: z.number().int().min(0), toMs: z.number().int().min(0) })).default([]),
      musicKey: objectKey.optional(),
      voiceoverKey: objectKey.optional(),
      endCard: z.object({ text: z.string().max(120), price: z.string().max(40).optional() }).optional(),
      watermark: z.boolean().default(true),
    })
    .superRefine((v, ctx) => {
      if (v.shotDurationsMs && v.shotDurationsMs.length !== v.shotKeys.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shotDurationsMs'], message: 'Give one planned duration for every shot.' });
      }
      if (v.targetDurationMs && v.shotDurationsMs) {
        const contentMs = v.shotDurationsMs.reduce((sum, duration) => sum + duration, 0);
        if (contentMs > v.targetDurationMs) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetDurationMs'], message: 'The target duration cannot be shorter than its shot timeline.' });
        }
        if (v.endCard && v.targetDurationMs - contentMs < 500) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetDurationMs'], message: 'Reserve at least half a second for the end card.' });
        }
      }
    }),
  TEXT_GENERATE: z.object({
    /** What to write. The worker builds the prompt; the customer never sees it. */
    task: z.enum(['product_copy', 'shot_plan', 'lyrics', 'field']).default('product_copy'),
    /** For task 'field': which part of an earlier copy result to write again, e.g. "captions.instagram". */
    field: z.string().max(60).optional(),
    /** For task 'field': what is there now, so the rewrite is a change and not a repeat. */
    previous: z.string().max(3000).optional(),
    /** For task 'field': what the seller wants different. */
    instruction: z.string().max(400).optional(),
    /** A stable id for the product (SKU, listing id) so a catalogue's descriptions are compared per product, not per photo. */
    productKey: z.string().max(120).optional(),
    sourceKey: objectKey.optional(),
    productName: z.string().max(120).optional(),
    details: z.string().max(2000).optional(),
    price: z.string().max(40).optional(),
    currency: z.string().length(3).optional(),
    language: z.string().max(16).default('en'),
    tone: z.string().max(80).optional(),
    platforms: z.array(z.enum(['instagram', 'tiktok', 'whatsapp_status', 'facebook', 'x'])).default(['instagram', 'whatsapp_status']),
  }),
  VOICEOVER: z.object({
    script: z.string().min(1).max(4000),
    language: z.string().max(16).default('en'),
    /** A VoiceProfile key from the catalogue. The voice decides the provider. */
    voiceId: z.string().max(80).optional(),
    /** How to read it. Providers that take direction get it; the rest ignore it. */
    style: z.enum(['natural', 'ad', 'calm', 'energetic', 'story']).default('natural'),
    speed: z.number().min(0.7).max(1.3).default(1),
    /** Filled by the pipeline from the voice row: the vendor's id for the voice. */
    providerVoiceId: z.string().max(120).optional(),
  }),
  /**
   * A song. Made once at full length, kept in the vault; the customer hears
   * a preview and pays to unlock the whole thing (the Frobits loop).
   */
  MUSIC: z.object({
    /** What the song is about, in the seller's words. */
    brief: z.string().min(3).max(2000),
    /** A MusicGenre key from the catalogue. */
    genre: z.string().max(60),
    title: z.string().max(120).optional(),
    mood: z.string().max(60).optional(),
    tempo: z.enum(['slow', 'mid', 'fast']).optional(),
    vocal: z.enum(['male', 'female', 'duet', 'choir', 'instrumental']).default('female'),
    /** Language of the lyrics. */
    language: z.string().max(16).default('en'),
    /** Their own lyrics. Absent with vocals → the pipeline writes them first. */
    lyrics: z.string().max(3000).optional(),
    /**
     * What to do with their text: 'exact' sings it as pasted; 'complete'
     * keeps every line they gave and writes the rest of the song around it;
     * 'inspire' treats it as a story or a memory and writes the song FROM it
     * (names, places and moments kept, nothing sung verbatim); 'auto' picks:
     * [Verse]/[Chorus] markers → exact, prose → inspire, a hook or a few
     * short lines → complete.
     */
    lyricsMode: z.enum(['auto', 'exact', 'complete', 'inspire']).default('auto'),
    /**
     * Who sings: the music model, or the seller ('me') — the model's vocal
     * is separated from the track and converted into their cloned voice.
     * Experimental: needs a CLONE VoiceProfile in the workspace (`voiceId`).
     */
    singer: z.enum(['model', 'me']).default('model'),
    /** The VoiceProfile key of their cloned voice, when `singer` is 'me'. */
    voiceId: z.string().max(80).optional(),
    durationSec: z.number().int().min(30).max(240).default(120),
    /** Set by the pipeline on the row after the lyrics step so a retry does not write them twice. */
    lyricsWritten: z.string().max(3000).optional(),
    /** Filled by the pipeline from the genre row: what the model is told about instruments and rhythm. */
    styleHints: z.string().max(1000).optional(),
    /** Filled by the pipeline: the final "[Verse]…" text the model sings. */
    lyricsText: z.string().max(4000).optional(),
  }),
  /**
   * A video, spoken again in another language in the same voice. With
   * `lipsync` the mouth is re-animated to match; without it the picture is
   * untouched and only the sound changes.
   */
  DUB: z.object({
    sourceKey: objectKey,
    /** A DUB_LANGUAGES code. */
    targetLanguage: z.string().max(16),
    /** ISO 639-1, or 'auto' to let the vendor listen first. */
    sourceLanguage: z.string().max(16).default('auto'),
    lipsync: z.boolean().default(false),
    /** 0 lets the vendor count the speakers. */
    speakers: z.number().int().min(0).max(10).default(0),
    /** Keep music and ambience under the new voice. */
    keepBackground: z.boolean().default(true),
    quality: z.enum(['speed', 'precision']).default('speed'),
    /** The seller confirms they may use this person's face and voice. Required — a dub clones a voice. */
    consent: z.literal(true, { errorMap: () => ({ message: 'Confirm you have permission to use this person’s face and voice.' }) }),
  }),
  /**
   * New words on an existing video, mouth re-animated to match: either an
   * audio file the seller uploads, or a script read by a catalogue voice
   * (the pipeline records it first).
   */
  LIPSYNC: z
    .object({
      sourceKey: objectKey,
      audioKey: objectKey.optional(),
      script: z.string().max(4000).optional(),
      /** A VoiceProfile key, when reading a script. */
      voiceId: z.string().max(80).optional(),
      language: z.string().max(16).default('en'),
      quality: z.enum(['speed', 'precision']).default('speed'),
      consent: z.literal(true, { errorMap: () => ({ message: 'Confirm you have permission to use this person’s face and voice.' }) }),
    })
    .refine((v) => Boolean(v.audioKey) || Boolean(v.script?.trim()), { message: 'Upload an audio file or write a script.', path: ['script'] }),
} satisfies Record<Capability, z.ZodTypeAny>;

/** A dub that also moves the mouth is priced under its own code. */
export const DUB_LIPSYNC_COST_CODE = 'video.translate_lipsync';
/** Vendors bill dubbing by the minute; these caps keep one credit price honest. */
export const DUB_MAX_SEC = 300;
export const LIPSYNC_MAX_SEC = 180;

export type CapabilityParams<C extends Capability = Capability> = z.infer<(typeof capabilityParams)[C]>;

/** Parse the params for a capability, or return the field-level problems. */
/**
 * Fields a pipeline writes onto the row as it works — the lyrics it wrote,
 * the shot plan it made, the vendor's id for a voice, the presenter it
 * already filmed. They exist so a RETRY does not redo settled work, and
 * they must never come in from outside: a "do it again" sends the row's
 * params straight back, and one of these riding along would make the
 * second song reuse the first song's words.
 */
export const PIPELINE_WRITTEN_KEYS: readonly string[] = [
  'lyricsWritten',
  'lyricsText',
  'styleHints',
  'providerVoiceId',
  'presenterClip',
  'plan',
  'caption',
  'shotIndex',
  'unlockedAt',
  'unlockLedgerEntryId',
];

/** A copy of the params with everything a pipeline writes for itself removed. */
export function withoutPipelineFields<T extends Record<string, unknown>>(params: T): T {
  const out = { ...params };
  for (const k of PIPELINE_WRITTEN_KEYS) delete out[k];
  return out;
}

/**
 * Whether a capability can actually take the photo on the canvas.
 *
 * Derived from the schema rather than listed by hand, because a hand-kept
 * list is exactly how a photo goes missing: IMAGE_GENERATE makes a picture
 * from words alone, so a `sourceKey` attached to it is stripped by the parser
 * without a word, and the customer is handed a stranger's face where they
 * expected their own photo. That happened. The studio now asks this before
 * attaching anything.
 */
/**
 * The field names a capability actually accepts. Anything else sent with a
 * request is stripped by the parser without complaint, so this is what the
 * studio checks its own controls against.
 */
export function capabilityFields(capability: Capability): string[] {
  let schema: z.ZodTypeAny = capabilityParams[capability];
  // .refine()/.superRefine() wrap the object; the shape is underneath.
  while (schema instanceof z.ZodEffects) schema = schema.innerType() as z.ZodTypeAny;
  return schema instanceof z.ZodObject ? Object.keys(schema.shape as Record<string, unknown>) : [];
}

export function acceptsSourceKey(capability: Capability): boolean {
  return capabilityFields(capability).includes('sourceKey');
}

export function parseCapabilityParams(
  capability: Capability,
  params: unknown,
): { ok: true; params: CapabilityParams } | { ok: false; issues: Record<string, string> } {
  const result = capabilityParams[capability].safeParse(params ?? {});
  if (result.success) return { ok: true, params: result.data as CapabilityParams };
  const issues: Record<string, string> = {};
  for (const issue of result.error.issues) issues[issue.path.join('.') || '_'] = issue.message;
  return { ok: false, issues };
}

/**
 * The CreditCost code a capability is priced under by default. The API may
 * derive a more specific server-owned code from validated params (for example,
 * a 30-second ad), but a request never supplies a price code directly.
 */
export const DEFAULT_COST_CODE: Record<Capability, string> = {
  IMAGE_GENERATE: 'image.storefront',
  IMAGE_EDIT: 'image.storefront',
  BACKGROUND_REMOVE: 'image.bg_remove',
  BACKGROUND_REPLACE: 'image.background',
  RELIGHT: 'image.relight',
  UPSCALE: 'image.upscale',
  COLLAGE: 'image.collage',
  PRODUCT_SHOT: 'image.product_shot', // on_model prices higher; the tool names the code
  BATCH: 'image.product_shot', // a batch is priced per photo: this code times the count
  IMAGE_TO_VIDEO: 'video.reel', // a multi-shot ad prices itself under video.ad_15s / video.ad_30s
  VIDEO_STITCH: 'video.stitch',
  TEXT_GENERATE: 'text.description',
  VOICEOVER: 'audio.voiceover',
  MUSIC: 'audio.music.preview',
  DUB: 'video.translate',
  LIPSYNC: 'video.lipsync',
};

/**
 * What one photo of a batch costs, and therefore what the batch costs.
 *
 * The server works this out from the params rather than trusting the client:
 * a batch of forty on-a-model shots is forty times the on-a-model price, and
 * a request that claimed otherwise would be forty premium renders for the
 * price of forty presses.
 */
export function batchUnitCostCode(of: Capability, params: Record<string, unknown>): string {
  if (of === 'PRODUCT_SHOT')
    return productShotCostCode(typeof params.mode === 'string' ? params.mode : undefined, typeof params.shotSize === 'string' ? params.shotSize : undefined);
  return DEFAULT_COST_CODE[of];
}

/** How much of a song is heard before paying, and what the rest costs. */
export const MUSIC_PREVIEW_SEC = 30;
export const MUSIC_UNLOCK_COST_CODE = 'audio.music.unlock';
/** A song sung in the seller's own voice is priced higher: the track, then stems and a voice conversion. */
export const MUSIC_MY_VOICE_COST_CODE = 'audio.music.preview.my_voice';
/** How long a voice sample must be to clone from, and how long is enough. */
export const VOICE_SAMPLE = { minSec: 10, idealSec: 30, maxSec: 180 } as const;

/** Outputs as a customer may see them: a locked track keeps its shape and loses its key. */
export function redactLocked<T extends { locked?: boolean; key: string }>(outputs: T[] | null | undefined): T[] {
  return (outputs ?? []).map((o) => (o.locked ? { ...o, key: '' } : o));
}
