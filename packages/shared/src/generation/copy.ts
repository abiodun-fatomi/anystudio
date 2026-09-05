/**
 * The shape of generated copy. One product photo in, this out — validated
 * on receipt, so a model that rambles never charges the customer for it.
 *
 * The JSON schema and the Zod schema describe the same thing; the first is
 * handed to the model, the second checks what came back.
 */

import { z } from 'zod';

export const PLATFORMS = ['instagram', 'tiktok', 'whatsapp_status', 'facebook', 'x'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Hard limits per platform. Copy that breaks them fails at post time, which is the worst time. */
export const PLATFORM_LIMITS: Record<Platform, { caption: number; hashtags: number }> = {
  instagram: { caption: 2200, hashtags: 30 },
  tiktok: { caption: 2200, hashtags: 10 },
  whatsapp_status: { caption: 700, hashtags: 3 },
  facebook: { caption: 2000, hashtags: 5 },
  x: { caption: 280, hashtags: 3 },
};

export const copyOutputSchema = z.object({
  description: z.object({
    long: z.string().min(40).max(1500),
    short: z.string().min(10).max(220),
    bullets: z.array(z.string().max(120)).min(2).max(6),
    specs: z.array(z.object({ label: z.string().max(40), value: z.string().max(80) })).max(8),
  }),
  captions: z
    .object({
      instagram: z.string().max(PLATFORM_LIMITS.instagram.caption),
      tiktok: z.string().max(PLATFORM_LIMITS.tiktok.caption),
      whatsapp_status: z.string().max(PLATFORM_LIMITS.whatsapp_status.caption),
      facebook: z.string().max(PLATFORM_LIMITS.facebook.caption),
      x: z.string().max(PLATFORM_LIMITS.x.caption),
    })
    .partial(),
  hashtags: z.object({
    broad: z.array(z.string().regex(/^#\S{2,40}$/)).max(10),
    niche: z.array(z.string().regex(/^#\S{2,40}$/)).max(10),
    local: z.array(z.string().regex(/^#\S{2,40}$/)).max(10),
  }),
  altText: z.string().min(10).max(250),
  seo: z.object({
    title: z.string().max(70),
    metaDescription: z.string().max(160),
    keywords: z.array(z.string().max(40)).max(12),
  }),
});
export type CopyOutput = z.infer<typeof copyOutputSchema>;

/** The same shape as JSON Schema, for the vendor's structured-output mode. */
export const COPY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    description: {
      type: 'object',
      properties: {
        long: { type: 'string', description: 'Storefront listing, 80–200 words, benefits before features' },
        short: { type: 'string', description: 'One or two sentences' },
        bullets: { type: 'array', items: { type: 'string' }, description: '2–6 concrete selling points' },
        specs: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] } },
      },
      required: ['long', 'short', 'bullets', 'specs'],
    },
    captions: {
      type: 'object',
      properties: {
        instagram: { type: 'string' },
        tiktok: { type: 'string' },
        whatsapp_status: { type: 'string', description: 'Short. Price, one line of appeal, how to order.' },
        facebook: { type: 'string' },
        x: { type: 'string', description: 'Under 280 characters including hashtags' },
      },
    },
    hashtags: {
      type: 'object',
      properties: {
        broad: { type: 'array', items: { type: 'string' } },
        niche: { type: 'array', items: { type: 'string' } },
        local: { type: 'array', items: { type: 'string' }, description: 'City and country tags where buyers search' },
      },
      required: ['broad', 'niche', 'local'],
    },
    altText: { type: 'string', description: 'What is in the image, for screen readers' },
    seo: {
      type: 'object',
      properties: { title: { type: 'string' }, metaDescription: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } },
      required: ['title', 'metaDescription', 'keywords'],
    },
  },
  required: ['description', 'captions', 'hashtags', 'altText', 'seo'],
};

/** A shot plan for a multi-shot ad: what the TEXT step writes and the video step executes. */
export const shotPlanSchema = z.object({
  hook: z.string().max(120),
  shots: z
    .array(
      z.object({
        prompt: z.string().min(10).max(600),
        motion: z.string().max(200),
        durationSec: z.union([z.literal(5), z.literal(8)]),
        caption: z.string().max(120),
      }),
    )
    .min(1)
    .max(4),
  endCard: z.object({ text: z.string().max(80), price: z.string().max(40).optional() }),
  music: z.object({ mood: z.string().max(40), tempo: z.enum(['slow', 'mid', 'fast']) }).optional(),
});
export type ShotPlan = z.infer<typeof shotPlanSchema>;

export const SHOT_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    hook: { type: 'string', description: 'The first on-screen line; stops the scroll' },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the camera sees, product identical to the reference' },
          motion: { type: 'string', description: 'Camera move: slow push-in, orbit, tilt up, rack focus…' },
          durationSec: { type: 'integer', enum: [5, 8] },
          caption: { type: 'string', description: 'On-screen text for this shot, under 10 words' },
        },
        required: ['prompt', 'motion', 'durationSec', 'caption'],
      },
    },
    endCard: { type: 'object', properties: { text: { type: 'string' }, price: { type: 'string' } }, required: ['text'] },
    music: { type: 'object', properties: { mood: { type: 'string' }, tempo: { type: 'string', enum: ['slow', 'mid', 'fast'] } }, required: ['mood', 'tempo'] },
  },
  required: ['hook', 'shots', 'endCard'],
};

/** One field, written again. */
export const fieldOutputSchema = z.object({ value: z.string().min(1).max(3000) });
export const FIELD_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { value: { type: 'string', description: 'The rewritten text, and nothing else' } },
  required: ['value'],
};

/** Labels and limits for the fields a seller can rewrite one at a time. */
export const COPY_FIELDS: Record<string, { label: string; max: number }> = {
  'description.long': { label: 'Description', max: 1500 },
  'description.short': { label: 'Short description', max: 220 },
  'captions.instagram': { label: 'Instagram caption', max: PLATFORM_LIMITS.instagram.caption },
  'captions.tiktok': { label: 'TikTok caption', max: PLATFORM_LIMITS.tiktok.caption },
  'captions.whatsapp_status': { label: 'WhatsApp Status caption', max: PLATFORM_LIMITS.whatsapp_status.caption },
  'captions.facebook': { label: 'Facebook caption', max: PLATFORM_LIMITS.facebook.caption },
  'captions.x': { label: 'X post', max: PLATFORM_LIMITS.x.caption },
  altText: { label: 'Alt text', max: 250 },
  'seo.title': { label: 'SEO title', max: 70 },
  'seo.metaDescription': { label: 'Meta description', max: 160 },
};

// ---------------------------------------------------------------- lyrics

/**
 * A song's words, in sections the music model understands. The pipeline
 * writes these with the copy model before the music model sings them, so
 * the seller can see and change the words the song will have.
 */
export const LYRICS_SECTION_TAGS = ['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'outro'] as const;
export const lyricsSchema = z.object({
  title: z.string().min(1).max(120),
  sections: z
    .array(
      z.object({
        tag: z.enum(LYRICS_SECTION_TAGS),
        lines: z.array(z.string().max(200)).min(1).max(12),
      }),
    )
    .min(1)
    .max(12),
});
export type Lyrics = z.infer<typeof lyricsSchema>;

export const LYRICS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short title for the song' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string', enum: [...LYRICS_SECTION_TAGS] },
          lines: { type: 'array', items: { type: 'string' }, description: 'One lyric line per item' },
        },
        required: ['tag', 'lines'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'sections'],
  additionalProperties: false,
};

/** "[Verse]\nline\nline\n\n[Chorus]\n…" — the form both music models read. */
export function lyricsToText(l: Lyrics): string {
  const label: Record<(typeof LYRICS_SECTION_TAGS)[number], string> = {
    intro: 'Intro',
    verse: 'Verse',
    'pre-chorus': 'Pre-Chorus',
    chorus: 'Chorus',
    bridge: 'Bridge',
    outro: 'Outro',
  };
  return l.sections.map((s) => `[${label[s.tag]}]\n${s.lines.join('\n')}`).join('\n\n');
}
