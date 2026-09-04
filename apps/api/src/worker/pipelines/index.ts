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
import type { BrandKit, Generation, Workspace } from '@prisma/client';
import type { Capability, GenerationStage, ProviderArtifact, ProviderFile, ProviderInput, ProviderResult } from '@anystudio/shared';
import type { Logger } from 'pino';
import { MediaService } from '../../modules/media/media.service';
import { copyPipeline } from './copy';
import { brandedImagePipeline } from './image';

export interface PipelineContext {
  row: Generation;
  workspace: Workspace;
  brandKit: BrandKit | null;
  files: Record<string, ProviderFile>;
  signal: AbortSignal;
  budgetMs: number;
  log: Logger;
  media: MediaService;
  callProvider: (
    input: Omit<ProviderInput, 'config'>,
    opts: { timeoutMs: number; signal: AbortSignal; onProgress?: (detail: string, progress?: number) => void },
  ) => Promise<ProviderResult>;
  stage: (stage: GenerationStage, progress: number, detail?: string) => Promise<void>;
}

export interface PipelineResult {
  artifacts: ProviderArtifact[];
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
  };

  run(ctx: PipelineContext): Promise<PipelineResult> {
    const pipeline = this.byCapability[ctx.row.capability] ?? passthrough;
    return pipeline(ctx);
  }
}
