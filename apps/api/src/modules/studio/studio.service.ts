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
import { PrismaClient, type WorkspaceType } from '@prisma/client';
import { z } from 'zod';
import type { LlmRequest, ProviderResult } from '@anystudio/shared';
import { logger } from '../../../config/logger';
import { isProductionDeployment } from '../../../config/environment';
import { MediaService } from '../media/media.service';
import { ProviderRouter } from '../provider/provider.router';
import type { CaptionsDto, IdeasDto, IdeaTool } from './studio.dto';

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
  /** Why the fallback, outside production: a blank suggestion box with no reason is impossible to debug. */
  reason?: string;
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
  required: ['ideas'],
  properties: {
    product: { type: 'string', description: 'The product in the photo, in at most eight words; omit if there is no photo' },
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

export interface CaptionIdea {
  /** A name for the angle: "Scarcity", "The detail", "Straight offer". */
  angle: string;
  /** The caption itself, without hashtags. */
  text: string;
  hashtags: string[];
  why: string;
}
export interface CaptionsOut {
  product: string | null;
  captions: CaptionIdea[];
  source: 'model' | 'stock';
  reason?: string;
}

const captionSchema = z.object({
  product: z.string().max(120).nullable().optional(),
  captions: z
    .array(
      z.object({
        angle: z.string().min(2).max(40),
        text: z.string().min(5).max(2000),
        hashtags: z.array(z.string().min(2).max(40)).max(30),
        why: z.string().min(5).max(200),
      }),
    )
    .min(1)
    .max(4),
});
const CAPTIONS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['captions'],
  properties: {
    product: { type: 'string', description: 'The product in the picture, in at most eight words; omit if there is no picture' },
    captions: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['angle', 'text', 'hashtags', 'why'],
        properties: {
          angle: { type: 'string', description: 'Two or three words naming the selling angle' },
          text: { type: 'string', description: 'The caption, ready to post, WITHOUT hashtags; line breaks allowed' },
          hashtags: { type: 'array', items: { type: 'string' }, description: 'Without the # sign; specific before generic' },
          why: { type: 'string', description: 'One sentence on why this one converts' },
        },
      },
    },
  },
} as const;

const PLATFORM_BRIEF: Record<string, string> = {
  instagram:
    'Instagram: the first line is what shows before "more" — make it the hook; 60–150 words is the sweet spot; 5–12 hashtags, niche and local before broad; one clear call to action (DM, link in bio, order via WhatsApp).',
  tiktok: 'TikTok: short — under 40 words; casual, first person; 3–6 hashtags; the caption supports the video, it is not the pitch.',
  whatsapp:
    'WhatsApp Status: no hashtags, no "link in bio"; short lines, the price and how to order ("reply to this status", "send a message"); emojis sparingly; under 60 words.',
  facebook: 'Facebook: conversational, 40–120 words, a question or a hook first, up to 5 hashtags, a clear "send a message" or "order" line.',
};
const GOAL_BRIEF: Record<string, string> = {
  sell: 'Goal: sell now — price, what they get, how to order, why today.',
  message: 'Goal: get people to send a message — ask a question they will want to answer, invite the DM.',
  launch: 'Goal: announce something new — the news first, what is different, how to be first.',
  restock: 'Goal: back in stock — who was waiting, how many, how to grab one.',
  promo: 'Goal: a promotion — the offer in the first line, the deadline, the mechanics in one line.',
  brand: 'Goal: brand warmth — the story, the maker, the craft; sell softly, one line of invitation at the end.',
};

const STOCK_CAPTIONS: CaptionIdea[] = [
  {
    angle: 'Straight offer',
    text: 'Now in stock. Send a message to order — delivery across the city.',
    hashtags: ['smallbusiness', 'shopsmall', 'nowinstock'],
    why: 'Says what it is and how to buy, nothing in the way.',
  },
  {
    angle: 'The question',
    text: 'Which one would you pick? Tell us below and we will hold it for you.',
    hashtags: ['smallbusiness', 'newarrival'],
    why: 'A question earns replies, and replies are the start of a sale.',
  },
  {
    angle: 'The detail',
    text: 'Look closer. Made to last, priced to move. DM for yours.',
    hashtags: ['madewithcare', 'shopsmall'],
    why: 'A detail justifies the price without arguing it.',
  },
  {
    angle: 'Only a few',
    text: 'A small batch, and when they go they go. Message us to hold one.',
    hashtags: ['smallbatch', 'shopsmall'],
    why: 'Honest scarcity moves the people who were already thinking about it.',
  },
  {
    angle: 'The maker',
    text: 'Made by hand, here, this week. Every one is a little different.',
    hashtags: ['handmade', 'supportlocal'],
    why: 'People buy from people; the story is the difference.',
  },
  {
    angle: 'For someone',
    text: 'Someone you know would love this. We wrap it for you — just say the word.',
    hashtags: ['giftideas', 'shopsmall'],
    why: 'Half of what a small business sells is bought for somebody else.',
  },
];

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

/**
 * What we hand back when no model could answer. Generic on purpose and
 * labelled as such — and six deep per tool, rotated by round, so "More"
 * always gives the seller something they have not just read.
 */
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
    {
      title: 'One turn around it',
      prompt: 'A slow half-orbit around the product on a plain surface, one soft light travelling across its edge as it turns.',
      motion: 'orbit',
      why: 'People wonder what the other side looks like; show them before they ask.',
    },
    {
      title: 'Out of the wrapping',
      prompt: 'Hands lifting the product out of its wrapping on a table, the paper falling away, the product settling in frame.',
      motion: 'handheld, following',
      why: 'The unwrapping is the moment a buyer imagines having it.',
    },
    {
      title: 'Two to choose from',
      prompt: 'The product beside a second one in another colour or size on the same surface, the camera drifting from one to the other.',
      motion: 'slow lateral slide',
      why: 'A choice invites a reply, and a reply is where the sale starts.',
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
    {
      title: 'Sunlit table',
      prompt: 'On a wooden table in late afternoon light, long soft shadows falling to one side.',
      why: 'Warm light makes anything look worth having.',
    },
    {
      title: 'Held up',
      prompt: 'Held in a hand against a plain wall, so its real size is obvious at a glance.',
      why: 'Scale is the question every online buyer has.',
    },
    {
      title: 'With its people',
      prompt: 'On a surface beside two or three everyday things it would sit with, softly out of focus behind.',
      why: 'A little context makes it feel real rather than cut out.',
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
    {
      title: 'Soft grey',
      prompt: 'A cool light-grey backdrop with a gentle vignette.',
      why: 'Neutral enough for any colour, and it never fights the product.',
    },
    { title: 'Marble', prompt: 'A pale marble surface with soft daylight from above.', why: 'Reads as premium without saying so.' },
    {
      title: 'Deep colour',
      prompt: 'A rich single-colour backdrop a shade darker than the product, evenly lit.',
      why: 'A bold ground makes a small product fill the frame.',
    },
  ],
  restyle: [
    { title: 'Warm film', prompt: 'Warm film look, golden hour, soft grain, gentle contrast.', why: 'Feels like a memory; performs well on feeds.' },
    { title: 'Clean and bright', prompt: 'Bright, airy, slightly lifted shadows, neutral whites.', why: 'Reads as trustworthy and new.' },
    { title: 'Bold and punchy', prompt: 'High contrast, saturated colour, crisp edges.', why: 'Stops a scrolling thumb.' },
    { title: 'Studio clean', prompt: 'Even light, true colours, no grain — as if it were reshot properly.', why: 'What a marketplace listing wants.' },
    { title: 'Evening warmth', prompt: 'Deep shadows, warm highlights, a little haze.', why: 'Suits food, candles and anything cosy.' },
    { title: 'Cool and modern', prompt: 'Cooler whites, crisp shadows, a little more contrast through the mid-tones.', why: 'Reads as new and well made.' },
  ],
};

/** Three of the set, moved on by the round, so asking again is never the same three. */
function rotate<T>(all: readonly T[], round: number, take = 3): T[] {
  if (all.length <= take) return [...all];
  const start = (round * take) % all.length;
  return Array.from({ length: take }, (_, i) => all[(start + i) % all.length]!);
}

@Injectable()
export class StudioService {
  private readonly cache = new Map<string, { at: number; out: IdeasOut }>();
  private readonly captionCache = new Map<string, { at: number; out: CaptionsOut }>();
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

    const round = dto.round ?? 0;
    if (!this.allow(workspaceId)) {
      logger.warn({ workspaceId, tool: dto.tool }, 'ideas: rate limit reached; answering with stock ideas');
      return this.stockIdeas(dto.tool, round, 'too many requests in the last hour');
    }

    let out: IdeasOut;
    try {
      out = await this.ask(workspaceId, dto);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, workspaceId, tool: dto.tool }, 'ideas: the model did not answer; answering with stock ideas');
      // Never cached: the next tap tries the model again rather than serving the fallback for fifteen minutes.
      return this.stockIdeas(dto.tool, round, reason);
    }
    this.cache.set(key, { at: Date.now(), out });
    return out;
  }

  /** Three captions with hashtags for a post — the same seller context, aimed at a platform and a goal. */
  async captions(workspaceId: string, dto: CaptionsDto): Promise<CaptionsOut> {
    const key = createHash('sha1')
      .update(
        JSON.stringify([
          'captions',
          workspaceId,
          dto.sourceKey ?? '',
          dto.platform ?? '',
          dto.kind ?? '',
          dto.goal ?? '',
          dto.productName ?? '',
          dto.price ?? '',
          dto.notes ?? '',
          dto.language ?? '',
          dto.round ?? 0,
        ]),
      )
      .digest('hex');
    const hit = this.captionCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.out;
    const round = dto.round ?? 0;
    if (!this.allow(workspaceId)) {
      logger.warn({ workspaceId }, 'captions: rate limit reached; answering with stock captions');
      return this.stockCaptions(round, dto.platform, 'too many requests in the last hour');
    }
    let out: CaptionsOut;
    try {
      out = await this.askCaptions(workspaceId, dto);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err: reason, workspaceId }, 'captions: the model did not answer; answering with stock captions');
      // Never cached: the next tap tries the model again rather than serving the fallback for fifteen minutes.
      return this.stockCaptions(round, dto.platform, reason);
    }
    this.captionCache.set(key, { at: Date.now(), out });
    return out;
  }

  private async askCaptions(workspaceId: string, dto: CaptionsDto): Promise<CaptionsOut> {
    const [workspace, brandKit] = await Promise.all([
      this.db.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
      this.db.brandKit.findUnique({ where: { workspaceId } }),
    ]);
    const profile = (workspace.profile as Record<string, unknown> | null) ?? {};
    const platform = dto.platform ?? 'instagram';
    const system = [
      'You write captions that sell for small businesses on social media. Plain words, no marketing jargon, no fake urgency, no claims the picture does not support.',
      PLATFORM_BRIEF[platform] ?? PLATFORM_BRIEF.instagram,
      dto.kind === 'story'
        ? 'It is a story: the text is short, one line of intent, the sticker does the rest.'
        : dto.kind === 'reel'
          ? 'It is a reel: the caption supports the video; keep it short and lead with the hook.'
          : '',
      GOAL_BRIEF[dto.goal ?? 'sell'],
      'Write exactly three captions, each a DIFFERENT selling angle (the offer straight; a question that earns replies; the detail or the story; scarcity or a deadline only when it is true; social proof only when given). Name each angle in two or three words.',
      'Hashtags separately, without the # sign: specific (the product, the city, the niche) before broad; none for WhatsApp.',
      `Language: ${dto.language ?? 'en'}. Local phrasing is welcome where it sounds natural.`,
      profile.sells ? `What this seller sells: ${String(profile.sells)}.` : '',
      brandKit?.tone ? `Their tone: ${brandKit.tone}.` : profile.tone ? `The tone they chose: ${String(profile.tone)}.` : '',
      brandKit?.businessName ? `Business name: ${brandKit.businessName}.` : '',
      workspace.region ? `Market: ${workspace.region.toUpperCase()} (prices in ${workspace.currency}).` : '',
      'Return only the structure requested.',
    ]
      .filter(Boolean)
      .join('\n');
    const parts: LlmRequest['parts'] = [];
    if (dto.sourceKey) {
      const asset = await this.db.mediaAsset.findFirst({ where: { workspaceId, key: dto.sourceKey }, select: { mime: true } });
      // Only an image can be looked at; a video's caption comes from the words alone.
      if (asset?.mime?.startsWith('image/')) parts.push({ imageUrl: await this.media.readUrl(workspaceId, dto.sourceKey), mime: asset.mime });
    }
    parts.push({
      text: [
        dto.productName ? `Product: ${dto.productName}` : parts.length ? 'Product: identify it from the picture' : 'Product: what this seller sells',
        dto.price ? `Price: ${dto.price}` : 'No price given — do not invent one.',
        dto.notes ? `The seller says: ${dto.notes}` : '',
        dto.round ? `Round ${dto.round + 1}: three different captions from the obvious ones.` : '',
        'Write the three captions now.',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    const result = await this.askAnyModel(workspaceId, workspace.type, `captions-${workspaceId.slice(0, 8)}`, {
      params: { task: 'captions', platform, goal: dto.goal ?? 'sell' },
      prompt: { system, parts, jsonSchema: CAPTIONS_JSON_SCHEMA, maxTokens: 1200, temperature: dto.round ? 0.95 : 0.8 },
    });
    const parsed = captionSchema.safeParse(result.artifacts.find((a) => a.text !== undefined)?.text);
    if (!parsed.success) {
      logger.warn({ workspaceId, providerKey: result.providerKey, issues: parsed.error.issues.slice(0, 3) }, 'captions: the model answered off-structure');
      throw new Error('off-structure');
    }
    logger.info({ workspaceId, platform, goal: dto.goal, providerKey: result.providerKey }, 'captions proposed');
    return {
      product: parsed.data.product ?? null,
      captions: parsed.data.captions.slice(0, 3).map((c) => ({
        ...c,
        hashtags:
          platform === 'whatsapp'
            ? []
            : c.hashtags
                .map((h) => h.replace(/^#/, '').replace(/\s+/g, ''))
                .filter(Boolean)
                .slice(0, 15),
      })),
      source: 'model',
    };
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

    const request: LlmRequest = { system, parts, jsonSchema: IDEAS_JSON_SCHEMA, maxTokens: 900, temperature: dto.round ? 0.9 : 0.7 };
    const result = await this.askAnyModel(workspaceId, workspace.type, `ideas-${workspaceId.slice(0, 8)}`, {
      params: { task: 'ideas', tool: dto.tool },
      prompt: request,
    });
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

  /**
   * Ask the text models, in the order the router ranked them, until one
   * answers.
   *
   * This used to take `decision.candidates[0]` and stop. The router was
   * still computing the rest and logging them as `fallbacks`, so the logs
   * said `fallbacks:["anthropic:claude-haiku-4.5"]` on every single call
   * while nothing was ever able to reach Anthropic. When Gemini started
   * refusing our schema, ideas fell straight through to the stock set —
   * for days, on every request, with a perfectly good second model sitting
   * unused behind a list we built and threw away.
   *
   * A fallback that is computed but not called is not a fallback.
   */
  private async askAnyModel(
    workspaceId: string,
    workspaceType: WorkspaceType,
    generationId: string,
    req: { params: Record<string, unknown>; prompt: LlmRequest },
  ): Promise<ProviderResult> {
    const decision = await this.router.route('TEXT_GENERATE', workspaceType);
    if (decision.candidates.length === 0) throw new Error('no TEXT_GENERATE provider');
    let last: unknown;
    for (const [i, candidate] of decision.candidates.entries()) {
      try {
        return await candidate.provider.generate(
          {
            generationId,
            workspaceId,
            capability: 'TEXT_GENERATE',
            params: req.params,
            files: {},
            config: { ...((candidate.row.config as Record<string, unknown> | null) ?? {}) },
            prompt: req.prompt,
          },
          { timeoutMs: 25_000 },
        );
      } catch (err) {
        last = err;
        const next = decision.candidates[i + 1]?.row.key;
        logger.warn(
          { workspaceId, providerKey: candidate.row.key, err: err instanceof Error ? err.message : String(err), next: next ?? null },
          next ? 'text model failed; asking the next one' : 'text model failed and there is no one left to ask',
        );
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /** The generic set, moved on by the round, with the reason attached outside production. */
  private stockIdeas(tool: IdeaTool, round: number, reason: string): IdeasOut {
    return { product: null, ideas: rotate(STOCK[tool], round), source: 'stock', ...this.why(reason) };
  }

  private stockCaptions(round: number, platform: string | undefined, reason: string): CaptionsOut {
    const captions = rotate(STOCK_CAPTIONS, round).map((c) => (platform === 'whatsapp' ? { ...c, hashtags: [] } : c));
    return { product: null, captions, source: 'stock', ...this.why(reason) };
  }

  /** Operators and developers get the reason; a customer in production gets the suggestions and no apology. */
  private why(reason: string): { reason?: string } {
    return isProductionDeployment() ? {} : { reason: reason.slice(0, 300) };
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
