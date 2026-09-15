/**
 * The playground: the portal's place to run the API on a photo without
 * writing a line of code. Each run is a real generation through the same
 * GenerationService an integration hits, charged to the workspace's credits
 * exactly as an integration would be — and, because every run costs real
 * provider money whether or not the workspace ever pays, capped per day per
 * workspace on top of the credits. The cap is a product term
 * (PLAYGROUND_DAILY_RUNS, 15 by default), counted from the rows themselves,
 * so a restart cannot reset it and a retry of the same photo (same clientKey
 * → same row) does not spend it.
 *
 * What can be run is a fixed menu of FEATURES, each a capability with its
 * parameters decided here — the page picks by key and never sends params,
 * so the playground cannot be used to reach anything the menu does not
 * name. The menu is the organization's shop window: every feature is priced
 * from the live credit table, and the two video ones cost what the real
 * thing costs, because seeing the price is the point.
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Capability } from '@anystudio/shared';
import { AppError, NotFoundError } from '../../../config/globals/errors';
import { GenerationService } from '../generation/generation.service';
import type { Actor } from '../auth/policy';

export const FEATURE_KEYS = ['check', 'copy', 'background', 'product_alone', 'cutout', 'enhance', 'reel', 'ugc'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

interface Feature {
  key: FeatureKey;
  capability: Capability;
  label: string;
  help: string;
  /** The credit_costs code the price comes from. */
  costCode: string;
  kind: 'image' | 'text' | 'video';
  params: (sourceKey: string, title: string | null, details: string | null) => Record<string, unknown>;
}

const FEATURES: Feature[] = [
  {
    key: 'check',
    capability: 'INSPECT',
    label: 'Product check',
    help: 'Is this a usable product photo, and is it the product the listing says?',
    costCode: 'image.inspect',
    kind: 'text',
    params: (sourceKey, title) => ({ sourceKey, ...(title ? { declared: { name: title } } : {}) }),
  },
  {
    key: 'copy',
    capability: 'TEXT_GENERATE',
    label: 'Listing copy',
    help: 'A description, bullets and specs no other listing is using — from the photo and what you tell it.',
    costCode: 'text.description',
    kind: 'text',
    params: (sourceKey, title, details) => ({ sourceKey, ...(title ? { productName: title } : {}), ...(details ? { details } : {}), language: 'en' }),
  },
  {
    key: 'background',
    capability: 'BACKGROUND_REPLACE',
    label: 'Clean background',
    help: 'The photo as taken, on a plain studio background, relit, with a shadow. Whatever is holding the product stays.',
    costCode: 'image.background',
    kind: 'image',
    params: (sourceKey) => ({ sourceKey, prompt: 'A plain warm white studio background, soft even light', shadow: true, relight: true }),
  },
  {
    key: 'product_alone',
    capability: 'PRODUCT_SHOT',
    label: 'Product alone',
    help: 'Hands, hangers and props taken out; the product by itself on a plain background.',
    costCode: 'image.product_shot',
    kind: 'image',
    params: (sourceKey) => ({
      sourceKey,
      mode: 'edit',
      prompt:
        'Remove any hand, person, hanger or prop holding or surrounding the product. Show the product alone, complete and unchanged, centred on a plain light background.',
      sizes: [],
    }),
  },
  {
    key: 'cutout',
    capability: 'BACKGROUND_REMOVE',
    label: 'Cut-out',
    help: 'The subject with the background removed — a transparent PNG for your own layouts.',
    costCode: 'image.bg_remove',
    kind: 'image',
    params: (sourceKey) => ({ sourceKey, background: 'transparent' }),
  },
  {
    key: 'enhance',
    capability: 'PRODUCT_SHOT',
    label: 'Enhance the photo',
    help: 'The same photo, sharper and better lit, nothing added.',
    costCode: 'image.product_shot',
    kind: 'image',
    params: (sourceKey) => ({ sourceKey, mode: 'beautify', sizes: [] }),
  },
  {
    key: 'reel',
    capability: 'IMAGE_TO_VIDEO',
    label: 'Reel',
    help: 'A five-second vertical product reveal from the one photo.',
    costCode: 'video.reel',
    kind: 'video',
    params: (sourceKey, title) => ({ sourceKey, format: 'reveal', shots: 1, durationSec: 5, aspect: '9:16', ...(title ? { productName: title } : {}) }),
  },
  {
    key: 'ugc',
    capability: 'IMAGE_TO_VIDEO',
    label: 'UGC ad',
    help: 'A 15-second ad with a presenter talking to camera, then the product.',
    costCode: 'video.ad_15s_presenter',
    kind: 'video',
    params: (sourceKey, title, details) => ({
      sourceKey,
      format: 'ugc',
      shots: 2,
      aspect: '9:16',
      presenter: { kind: 'stock', key: 'daphne' },
      ...(title ? { productName: title } : {}),
      ...(details ? { details } : {}),
    }),
  },
];
const FEATURE_BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));
const PREFIX = 'playground:';

export interface Allowance {
  /** Generations the playground may start per UTC day, per workspace. */
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  /** When `usedToday` goes back to zero. */
  resetsAt: string;
}

export interface FeatureView {
  key: FeatureKey;
  capability: Capability;
  label: string;
  help: string;
  kind: 'image' | 'text' | 'video';
  credits: number;
}

export class PlaygroundExhaustedError extends AppError {
  constructor(allowance: Allowance) {
    super(
      'playground_exhausted',
      429,
      `Today's playground allowance (${allowance.dailyLimit} runs) is used up. It resets at midnight UTC; your API keys are not limited this way.`,
      { allowance },
    );
  }
}

export function dailyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PLAYGROUND_DAILY_RUNS);
  return Number.isInteger(n) && n > 0 ? n : 15;
}

@Injectable()
export class PlaygroundService {
  constructor(
    private readonly db: PrismaClient,
    private readonly generations: GenerationService,
  ) {}

  async allowance(workspaceId: string, now = new Date()): Promise<Allowance> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const resetsAt = new Date(start.getTime() + 86_400_000);
    const usedToday = await this.db.generation.count({ where: { workspaceId, clientKey: { startsWith: PREFIX }, createdAt: { gte: start } } });
    const limit = dailyLimit();
    return { dailyLimit: limit, usedToday, remaining: Math.max(0, limit - usedToday), resetsAt: resetsAt.toISOString() };
  }

  /** The menu, priced from the live credit table — never from a number written into a page. */
  async features(): Promise<FeatureView[]> {
    const rows = await this.db.creditCost.findMany({ where: { code: { in: [...new Set(FEATURES.map((f) => f.costCode))] } } });
    const price = new Map(rows.map((r) => [r.code, r.credits]));
    return FEATURES.map((f) => ({ key: f.key, capability: f.capability, label: f.label, help: f.help, kind: f.kind, credits: price.get(f.costCode) ?? 0 }));
  }

  /**
   * Start the chosen features on one uploaded photo. Every one is a real
   * row: charged, queued, streamed and listed like any other. The clientKey
   * is the photo and the feature, so running the same photo again returns
   * the rows already made rather than charging twice.
   */
  async run(actor: Actor, workspaceId: string, input: { assetId: string; features: FeatureKey[]; title?: string | null; details?: string | null }) {
    const asset = await this.db.mediaAsset.findFirst({ where: { id: input.assetId, workspaceId }, select: { id: true, key: true, status: true } });
    if (!asset) throw new NotFoundError('That photo is not in this workspace.');
    const picked = [...new Set(input.features)].map((k) => FEATURE_BY_KEY.get(k)).filter((f): f is Feature => f !== undefined);
    const title = input.title?.trim() || null;
    const details = input.details?.trim() || null;
    const stem = asset.id.slice(0, 8);

    // What would actually be new work: a replay costs nothing and is not counted.
    const keys = picked.map((f) => `${PREFIX}${stem}:${f.key}:v1`);
    const existing = await this.db.generation.findMany({ where: { workspaceId, clientKey: { in: keys } }, select: { clientKey: true } });
    const fresh = keys.filter((k) => !existing.some((e) => e.clientKey === k)).length;
    const allowance = await this.allowance(workspaceId);
    if (fresh > allowance.remaining) throw new PlaygroundExhaustedError(allowance);

    const runs = [];
    let balance = 0;
    for (const f of picked) {
      const out = await this.generations.request({
        workspaceId,
        requestedById: actor.userId,
        capability: f.capability,
        params: f.params(asset.key, title, details),
        clientKey: `${PREFIX}${stem}:${f.key}:v1`,
        channel: 'WEB',
      });
      balance = out.balance;
      runs.push({ feature: f.key, capability: f.capability, generation: out.generation });
    }
    return { runs, balance, allowance: await this.allowance(workspaceId) };
  }
}
