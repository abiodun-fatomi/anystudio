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

export const CAPABILITIES = [
  'IMAGE_GENERATE',
  'IMAGE_EDIT',
  'BACKGROUND_REMOVE',
  'BACKGROUND_REPLACE',
  'RELIGHT',
  'UPSCALE',
  'IMAGE_TO_VIDEO',
  'VIDEO_STITCH',
  'TEXT_GENERATE',
  'VOICEOVER',
  'MUSIC',
  'DUB',
  'LIPSYNC',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const isCapability = (v: unknown): v is Capability =>
  typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);

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
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const HEAVY: ReadonlySet<Capability> = new Set<Capability>([
  'IMAGE_TO_VIDEO',
  'VIDEO_STITCH',
  'MUSIC',
  'DUB',
  'LIPSYNC',
]);

/** Which queue carries a capability. Video and audio wait on GPUs; the rest do not. */
export const queueFor = (capability: Capability): QueueName =>
  HEAVY.has(capability) ? QUEUES.heavy : QUEUES.fast;

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
export const objectKey = z.string().min(3).max(512).regex(/^[A-Za-z0-9/_.-]+$/);

export const ASPECTS = ['1:1', '4:5', '9:16', '16:9', '3:4'] as const;
export type Aspect = (typeof ASPECTS)[number];

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

export const capabilityParams = {
  IMAGE_GENERATE: z.object({
    prompt: z.string().min(3).max(2000),
    aspect: z.enum(ASPECTS).default('1:1'),
    style: z.string().max(200).optional(),
    negativePrompt: z.string().max(1000).optional(),
    count: z.number().int().min(1).max(4).default(1),
  }),
  IMAGE_EDIT: z.object({
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
  IMAGE_TO_VIDEO: z.object({
    sourceKey: objectKey,
    prompt: z.string().min(3).max(2000),
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
    shots: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
    /** The ad's shape, for the planner. */
    format: z.enum(['reveal', 'benefits', 'before_after', 'unboxing', 'price_drop', 'ugc']).default('reveal'),
    /** Words for the end card; the price comes from the copy fields when present. */
    productName: z.string().max(120).optional(),
    price: z.string().max(40).optional(),
    details: z.string().max(800).optional(),
    /** Shot-level fields the planner writes; a customer never sets them. */
    caption: z.string().max(120).optional(),
    shotIndex: z.number().int().min(0).max(7).optional(),
  }),
  VIDEO_STITCH: z.object({
    /** Ordered shot keys — each one an IMAGE_TO_VIDEO output. */
    shotKeys: z.array(objectKey).min(1).max(8),
    aspect: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
    captions: z.array(z.object({ text: z.string().max(200), fromMs: z.number().int().min(0), toMs: z.number().int().min(0) })).default([]),
    musicKey: objectKey.optional(),
    voiceoverKey: objectKey.optional(),
    endCard: z.object({ text: z.string().max(120), price: z.string().max(40).optional() }).optional(),
    watermark: z.boolean().default(true),
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
    durationSec: z.number().int().min(30).max(240).default(120),
    /** Set by the pipeline on the row after the lyrics step so a retry does not write them twice. */
    lyricsWritten: z.string().max(3000).optional(),
    /** Filled by the pipeline from the genre row: what the model is told about instruments and rhythm. */
    styleHints: z.string().max(1000).optional(),
    /** Filled by the pipeline: the final "[Verse]…" text the model sings. */
    lyricsText: z.string().max(4000).optional(),
  }),
  DUB: z.object({
    sourceKey: objectKey,
    targetLanguage: z.string().max(16),
    lipsync: z.boolean().default(false),
  }),
  LIPSYNC: z.object({
    sourceKey: objectKey,
    audioKey: objectKey,
  }),
} satisfies Record<Capability, z.ZodTypeAny>;

export type CapabilityParams<C extends Capability = Capability> = z.infer<(typeof capabilityParams)[C]>;

/** Parse the params for a capability, or return the field-level problems. */
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
 * The CreditCost code a capability is priced under by default. A request may
 * override this (a 30-second ad prices its shots under video.ad_30s), but
 * the mapping the studio quotes from lives here so the UI and the API agree.
 */
export const DEFAULT_COST_CODE: Record<Capability, string> = {
  IMAGE_GENERATE: 'image.storefront',
  IMAGE_EDIT: 'image.storefront',
  BACKGROUND_REMOVE: 'image.bg_remove',
  BACKGROUND_REPLACE: 'image.background',
  RELIGHT: 'image.relight',
  UPSCALE: 'image.upscale',
  IMAGE_TO_VIDEO: 'video.reel', // a multi-shot ad prices itself under video.ad_15s / video.ad_30s
  VIDEO_STITCH: 'video.stitch',
  TEXT_GENERATE: 'text.description',
  VOICEOVER: 'audio.voiceover',
  MUSIC: 'audio.music.preview',
  DUB: 'video.translate',
  LIPSYNC: 'video.lipsync',
};

/** How much of a song is heard before paying, and what the rest costs. */
export const MUSIC_PREVIEW_SEC = 30;
export const MUSIC_UNLOCK_COST_CODE = 'audio.music.unlock';

/** Outputs as a customer may see them: a locked track keeps its shape and loses its key. */
export function redactLocked<T extends { locked?: boolean; key: string }>(outputs: T[] | null | undefined): T[] {
  return (outputs ?? []).map((o) => (o.locked ? { ...o, key: '' } : o));
}
