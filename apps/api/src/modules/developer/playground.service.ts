/**
 * The playground: the portal's place to run the API on a photo without
 * writing a line of code. Each run is a real generation through the same
 * GenerationService an integration hits, charged to the workspace's credits
 * exactly as an integration would be — and, because every run costs real
 * provider money whether or not the workspace ever pays, capped per day per
 * workspace on top of the credits. The cap is a product term
 * (PLAYGROUND_DAILY_RUNS, 15 by default: five full three-call runs), counted
 * from the rows themselves, so a restart cannot reset it and a retry of the
 * same photo (same clientKey → same row) does not spend it.
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../../config/globals/errors';
import { GenerationService } from '../generation/generation.service';
import type { Actor } from '../auth/policy';

export type PlaygroundCapability = 'INSPECT' | 'BACKGROUND_REPLACE' | 'TEXT_GENERATE';
export const PLAYGROUND_CAPABILITIES: PlaygroundCapability[] = ['INSPECT', 'BACKGROUND_REPLACE', 'TEXT_GENERATE'];
const PREFIX = 'playground:';

export interface Allowance {
  /** Generations the playground may start per UTC day, per workspace. */
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  /** When `usedToday` goes back to zero. */
  resetsAt: string;
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

  /**
   * Start the chosen calls on one uploaded photo. Every one is a real row:
   * charged, queued, streamed and listed like any other. The clientKey is
   * the photo and the capability, so running the same photo again returns
   * the rows already made rather than charging twice.
   */
  async run(actor: Actor, workspaceId: string, input: { assetId: string; capabilities: PlaygroundCapability[]; title?: string | null }) {
    const asset = await this.db.mediaAsset.findFirst({ where: { id: input.assetId, workspaceId }, select: { id: true, key: true, status: true } });
    if (!asset) throw new NotFoundError('That photo is not in this workspace.');
    const caps = [...new Set(input.capabilities)].filter((c) => PLAYGROUND_CAPABILITIES.includes(c));
    const title = input.title?.trim() || null;
    const stem = asset.id.slice(0, 8);

    // What would actually be new work: a replay costs nothing and is not counted.
    const keys = caps.map((c) => `${PREFIX}${stem}:${c.toLowerCase()}:v1`);
    const existing = await this.db.generation.findMany({ where: { workspaceId, clientKey: { in: keys } }, select: { clientKey: true } });
    const fresh = keys.filter((k) => !existing.some((e) => e.clientKey === k)).length;
    const allowance = await this.allowance(workspaceId);
    if (fresh > allowance.remaining) throw new PlaygroundExhaustedError(allowance);

    const params: Record<PlaygroundCapability, Record<string, unknown>> = {
      INSPECT: { sourceKey: asset.key, ...(title ? { declared: { name: title } } : {}) },
      BACKGROUND_REPLACE: { sourceKey: asset.key, prompt: 'A plain warm white studio background, soft even light', shadow: true, relight: true },
      TEXT_GENERATE: { sourceKey: asset.key, ...(title ? { productName: title } : {}), language: 'en' },
    };
    const runs = [];
    let balance = 0;
    for (const capability of caps) {
      const out = await this.generations.request({
        workspaceId,
        requestedById: actor.userId,
        capability,
        params: params[capability],
        clientKey: `${PREFIX}${stem}:${capability.toLowerCase()}:v1`,
        channel: 'WEB',
      });
      balance = out.balance;
      runs.push({ capability, generation: out.generation });
    }
    return { runs, balance, allowance: await this.allowance(workspaceId) };
  }
}
