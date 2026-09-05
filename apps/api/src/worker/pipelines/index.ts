/**
 * Pipelines: what happens between "the provider was routed" and "the outputs
 * are stored", per capability.
 *
 * Most capabilities are one provider call. The ones that are not — copy
 * (which needs a prompt built from the brand and the workspace), branded
 * images (which need size variants) — get a function here. A pipeline never
 * imports a vendor; it asks `ctx.callProvider` and shapes what comes back.
 */

import { Injectable } from '@nestjs/common';
import type { BrandKit, Generation, PrismaClient, Workspace } from '@prisma/client';
import type { Capability, GenerationOutput, GenerationStage, ProviderArtifact, ProviderFile, ProviderInput, ProviderResult } from '@anystudio/shared';
import type { Logger } from 'pino';
import { MediaService } from '../../modules/media/media.service';
import { copyPipeline } from './copy';
import { musicPipeline } from './music';
import { voiceoverPipeline } from './voiceover';
import { brandedImagePipeline } from './image';
import { adPipeline } from './ad';
import type { GenerationService } from '../../modules/generation/generation.service';

export interface PipelineContext {
  row: Generation;
  workspace: Workspace;
  brandKit: BrandKit | null;
  files: Record<string, ProviderFile>;
  signal: AbortSignal;
  budgetMs: number;
  log: Logger;
  media: MediaService;
  /** For pipelines that keep their own rows — copy fingerprints. Never for money. */
  db: PrismaClient;
  /** For a parent that creates children. */
  generations: GenerationService;
  /** True on a parent's second run, after its children finished. */
  resume: boolean;
  callProvider: (
    input: Omit<ProviderInput, 'config'>,
    opts: { timeoutMs: number; signal: AbortSignal; onProgress?: (detail: string, progress?: number) => void },
  ) => Promise<ProviderResult>;
  /** Route and call a DIFFERENT capability — a pipeline that cuts out before it edits. */
  callCapability: (
    capability: Capability,
    input: Omit<ProviderInput, 'config' | 'capability'>,
    opts: { timeoutMs: number; signal: AbortSignal; onProgress?: (detail: string, progress?: number) => void },
  ) => Promise<ProviderResult>;
  stage: (stage: GenerationStage, progress: number, detail?: string) => Promise<void>;
}

export interface PipelineResult {
  artifacts: ProviderArtifact[];
  /** Outputs the pipeline already stored itself (a vaulted song); described here, not uploaded again. */
  extraOutputs?: GenerationOutput[];
  /** A parent that dispatched children and steps aside; the runner leaves it RUNNING at stage 'waiting'. */
  waiting?: boolean;
  providerKey?: string;
  providerJobId?: string;
  costMinor?: number;
}

export type Pipeline = (ctx: PipelineContext) => Promise<PipelineResult>;

/** One provider call, its artifacts returned as they are. */
export const passthrough: Pipeline = async (ctx) => {
  const result = await ctx.callProvider(
    { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, capability: ctx.row.capability, params: ctx.row.input as Record<string, unknown>, files: ctx.files },
    { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('generating', progress ?? 40, detail) },
  );
  return { artifacts: result.artifacts, providerKey: result.providerKey, providerJobId: result.providerJobId, costMinor: result.costMinor };
};

@Injectable()
export class Pipelines {
  private readonly byCapability: Partial<Record<Capability, Pipeline>> = {
    TEXT_GENERATE: copyPipeline,
    IMAGE_EDIT: brandedImagePipeline,
    MUSIC: musicPipeline,
    VOICEOVER: voiceoverPipeline,
  };

  run(ctx: PipelineContext): Promise<PipelineResult> {
    // A multi-shot video is a plan, not a call. Its children are ordinary single-shot rows.
    if (ctx.row.capability === 'IMAGE_TO_VIDEO' && ctx.row.kind === 'PARENT') return adPipeline(ctx);
    const pipeline = this.byCapability[ctx.row.capability] ?? passthrough;
    return pipeline(ctx);
  }
}
