/**
 * Ideas — what a marketer would tell this seller to make, for this product.
 *
 * "What happens" is a blank box, and a blank box is where most sellers
 * stop. So before they type, the copy model looks at their photo and what
 * we know about them (what they sell, the tone they chose, where they
 * sell, the format and length they picked) and proposes three directions
 * a good creative director would — each with the shot direction ready to
 * use, a camera move, and one line on why it sells. A tap fills the box.
 *
 * It is a synchronous call on the API, not a queued generation: it has to
 * come back in a few seconds while the panel is open. It is free to the
 * customer and cheap to us (one small vision call), so it is guarded
 * rather than priced: a per-workspace rate limit and a short cache keyed
 * on the photo and the settings, so flipping the length back and forth
 * does not call the vendor twice.
 *
 * With no text vendor (a bare dev box) the stub answers; if even that
 * fails, a short hand-written set for the format goes back — the panel
 * never shows an error for a feature that is only a suggestion.
 */
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { LlmRequest } from '@anystudio/shared';
import { logger } from '../../../config/logger';
import { MediaService } from '../media/media.service';
import { ProviderRouter } from '../provider/provider.router';
import type { IdeasDto, IdeaTool } from './studio.dto';

export interface Idea {
  title: string;
  prompt: string;
  motion?: string;
  why: string;
}
export interface IdeasOut {
  /** What the model saw, in a few words — shown so the seller can correct it. */
  product: string | null;
  ideas: Idea[];
  /** 'model' when a vendor wrote them, 'stock' when these are the generic fallback. */
  source: 'model' | 'stock';
}

const ideaSchema = z.object({
  product: z.string().max(120).nullable().optional(),
  ideas: z
    .array(
      z.object({
        title: z.string().min(2).max(60),
        prompt: z.string().min(10).max(500),
        motion: z.string().max(120).optional(),
        why: z.string().min(5).max(200),
      }),
    )
    .min(1)
    .max(4),
});
const IDEAS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['product', 'ideas'],
  properties: {
    product: { type: 'string', description: 'The product in the photo, in at most eight words' },
    ideas: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'prompt', 'why'],
        properties: {
          title: { type: 'string', description: 'Three to five words' },
          prompt: { type: 'string', description: 'The direction, ready to paste, under 60 words, concrete to this product' },
          motion: { type: 'string', description: 'Video only: one camera move, e.g. "slow push-in"' },
          why: { type: 'string', description: 'One sentence: why this sells for this seller and audience' },
        },
      },
    },
  },
} as const;

const CACHE_TTL_MS = 15 * 60_000;
const RATE = { perHour: 60 };

const FORMAT_BRIEF: Record<string, string> = {
  reveal: 'a product reveal — start close and abstract, pull back to the whole product, settle on it',
  benefits: 'three benefits, one per shot, each in the situation where it matters',
  before_after: 'before and after — the problem, the product solving it, the result',
  unboxing: 'an unboxing — the box, the reveal, in hand, in use',
  price_drop: 'a price-drop announcement — energetic, best angles, building to the price',
  ugc: 'filmed like a customer did it on a phone — handheld, natural light, real life',
};

const TOOL_BRIEF: Record<IdeaTool, string> = {
  video: 'a short vertical product video for WhatsApp Status, Instagram Reels and TikTok, generated shot by shot from this one photo',
  scene: 'a new scene for this product photo: the product stays exactly as photographed, the surroundings are generated',
  background: 'a replacement background behind this product cutout, for a shop listing or a feed post',
  restyle: 'a restyle of this whole photo — a look, a mood, a treatment',
};

/** What we hand back when no model could answer. Generic on purpose and labelled as such. */
const STOCK: Record<IdeaTool, Idea[]> = {
  video: [
    {
      title: 'Close, then the whole thing',
      prompt: 'Start tight on the most striking detail of the product, then pull back slowly until the whole product is in frame on a clean surface.',
      motion: 'slow pull-back',
      why: 'A detail first makes people stop; the reveal pays it off.',
    },
    {
      title: 'In real hands',
      prompt: 'The product picked up and turned in someone’s hands in natural window light, so its size and finish are obvious.',
      motion: 'handheld, gentle',
      why: 'Seeing scale and texture answers the two questions buyers ask before they message.',
    },
    {
      title: 'Where it lives',
      prompt: 'The product in the place it would be used, morning light, one slow move across it, ending settled and centred.',
      motion: 'slow lateral slide',
      why: 'Context lets a buyer picture owning it, which is what converts.',
    },
  ],
  scene: [
    {
      title: 'Clean studio',
      prompt: 'On a plain warm-white studio surface with a soft shadow, nothing else in frame.',
      why: 'Marketplaces and catalogues favour it, and it never dates.',
    },
    {
      title: 'Where it is used',
      prompt: 'In the place it would actually be used, soft morning light from one side, a little depth of field behind.',
      why: 'Context sells; a buyer sees it in their own life.',
    },
    {
      title: 'Premium dark',
      prompt: 'On a dark matte surface with one soft rim light and a faint reflection.',
      why: 'Reads as expensive; good for higher-priced items.',
    },
  ],
  background: [
    {
      title: 'Warm beige studio',
      prompt: 'Plain warm beige studio backdrop with a soft gradient.',
      why: 'Flattering to most colours and keeps attention on the product.',
    },
    {
      title: 'Natural wood',
      prompt: 'A light oak tabletop with soft daylight from the left.',
      why: 'Feels handmade and honest; suits food, crafts and fashion.',
    },
    { title: 'Pure white', prompt: 'Seamless pure white, no horizon line.', why: 'What marketplaces ask for; cuts out cleanly anywhere.' },
  ],
  restyle: [
    { title: 'Warm film', prompt: 'Warm film look, golden hour, soft grain, gentle contrast.', why: 'Feels like a memory; performs well on feeds.' },
    { title: 'Clean and bright', prompt: 'Bright, airy, slightly lifted shadows, neutral whites.', why: 'Reads as trustworthy and new.' },
    { title: 'Bold and punchy', prompt: 'High contrast, saturated colour, crisp edges.', why: 'Stops a scrolling thumb.' },
  ],
};

@Injectable()
export class StudioService {
  private readonly cache = new Map<string, { at: number; out: IdeasOut }>();
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly db: PrismaClient,
    private readonly media: MediaService,
    private readonly router: ProviderRouter,
  ) {}

  async ideas(workspaceId: string, dto: IdeasDto): Promise<IdeasOut> {
    const key = createHash('sha1')
      .update(
        JSON.stringify([workspaceId, dto.tool, dto.sourceKey ?? '', dto.format ?? '', dto.shots ?? 1, dto.productName ?? '', dto.price ?? '', dto.round ?? 0]),
      )
      .digest('hex');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.out;
    this.sweep();

    if (!this.allow(workspaceId)) {
      logger.warn({ workspaceId, tool: dto.tool }, 'ideas: rate limit reached; answering with stock ideas');
      return { product: null, ideas: STOCK[dto.tool], source: 'stock' };
    }

    let out: IdeasOut;
    try {
      out = await this.ask(workspaceId, dto);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, workspaceId, tool: dto.tool },
        'ideas: the model did not answer; answering with stock ideas',
      );
      out = { product: null, ideas: STOCK[dto.tool], source: 'stock' };
    }
    this.cache.set(key, { at: Date.now(), out });
    return out;
  }

  private async ask(workspaceId: string, dto: IdeasDto): Promise<IdeasOut> {
    const [workspace, brandKit] = await Promise.all([
      this.db.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
      this.db.brandKit.findUnique({ where: { workspaceId } }),
    ]);
    const profile = (workspace.profile as Record<string, unknown> | null) ?? {};
    const isVideo = dto.tool === 'video';
    const shots = dto.shots ?? 1;
    const length = isVideo ? (shots <= 1 ? 'a 5–8 second reel, one shot' : `a ${{ 2: 15, 4: 30, 6: 45, 8: 60 }[shots] ?? 30}-second ad in ${shots} shots`) : '';
    const region = workspace.region ? `Market: ${workspace.region.toUpperCase()} (prices in ${workspace.currency}).` : '';

    const system = [
      'You are a creative director for small sellers who sell through WhatsApp, Instagram and marketplaces. You propose what to make, not vague advice.',
      `The seller is making ${TOOL_BRIEF[dto.tool]}.`,
      isVideo ? `Length: ${length}. Format: ${FORMAT_BRIEF[dto.format ?? 'reveal'] ?? FORMAT_BRIEF.reveal}.` : '',
      'Look at the photo. Name the product in a few words. Then propose exactly three distinct directions, each one a different selling angle (for example: the detail that justifies the price; the moment it is used; the problem it removes; scarcity or a drop; social proof; a gift). Pick the three that fit THIS product and THIS seller best — never the same three for every product.',
      'Each direction: a title of three to five words; the direction itself as the seller would type it into the tool — concrete, visual, under 60 words, naming surfaces, light and what moves; the product must stay exactly as photographed (same shape, colours, label); no people unless the format is "filmed by a customer"; no on-screen text (captions are added later).',
      isVideo ? 'Add one camera move per direction (push-in, orbit, tilt, slide, handheld, rack focus).' : '',
      'And one sentence on why it sells, in plain words a seller understands — no marketing jargon.',
      profile.sells ? `What this seller sells: ${String(profile.sells)}.` : '',
      profile.tone ? `The tone they chose: ${String(profile.tone)}.` : brandKit?.tone ? `Their tone: ${brandKit.tone}.` : '',
      Array.isArray(profile.channels) && profile.channels.length ? `Where they sell: ${(profile.channels as string[]).join(', ')}.` : '',
      region,
      'Return only the structure requested.',
    ]
      .filter(Boolean)
      .join('\n');

    const parts: LlmRequest['parts'] = [];
    if (dto.sourceKey) {
      const url = await this.media.readUrl(workspaceId, dto.sourceKey);
      const asset = await this.db.mediaAsset.findFirst({ where: { workspaceId, key: dto.sourceKey }, select: { mime: true } });
      parts.push({ imageUrl: url, mime: asset?.mime ?? 'image/jpeg' });
    }
    parts.push({
      text: [
        dto.productName
          ? `Product: ${dto.productName}`
          : dto.sourceKey
            ? 'Product: identify it from the photo'
            : 'No photo yet; propose for what this seller sells.',
        dto.price ? `Price: ${dto.price}` : '',
        dto.round ? `This is round ${dto.round + 1}: give three directions different from the obvious ones.` : '',
        'Propose the three directions now.',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    const decision = await this.router.route('TEXT_GENERATE', workspace.type);
    const candidate = decision.candidates[0];
    if (!candidate) throw new Error('no TEXT_GENERATE provider');
    const request: LlmRequest = { system, parts, jsonSchema: IDEAS_JSON_SCHEMA, maxTokens: 900, temperature: dto.round ? 0.9 : 0.7 };
    const result = await candidate.provider.generate(
      {
        generationId: `ideas-${workspaceId.slice(0, 8)}`,
        workspaceId,
        capability: 'TEXT_GENERATE',
        params: { task: 'ideas', tool: dto.tool },
        files: {},
        config: { ...((candidate.row.config as Record<string, unknown> | null) ?? {}) },
        prompt: request,
      },
      { timeoutMs: 25_000 },
    );
    const text = result.artifacts.find((a) => a.text !== undefined)?.text;
    const parsed = ideaSchema.safeParse(text);
    if (!parsed.success) {
      logger.warn({ workspaceId, providerKey: result.providerKey, issues: parsed.error.issues.slice(0, 3) }, 'ideas: the model answered off-structure');
      throw new Error('off-structure');
    }
    logger.info({ workspaceId, tool: dto.tool, providerKey: result.providerKey, product: parsed.data.product }, 'ideas proposed');
    return {
      product: parsed.data.product ?? null,
      ideas: parsed.data.ideas.slice(0, 3).map((i) => ({ title: i.title, prompt: i.prompt, motion: isVideo ? i.motion : undefined, why: i.why })),
      source: 'model',
    };
  }

  private allow(workspaceId: string): boolean {
    const now = Date.now();
    const recent = (this.calls.get(workspaceId) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= RATE.perHour) return false;
    recent.push(now);
    this.calls.set(workspaceId, recent);
    return true;
  }

  private sweep(): void {
    if (this.cache.size < 2000) return;
    const now = Date.now();
    for (const [k, v] of this.cache) if (now - v.at > CACHE_TTL_MS) this.cache.delete(k);
  }
}
