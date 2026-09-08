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
import type {
  Capability,
  GenerationOutput,
  GenerationProvider,
  GenerationStage,
  ProviderArtifact,
  ProviderFile,
  ProviderInput,
  ProviderOpts,
  ProviderResult,
} from '@anystudio/shared';
import type { Logger } from 'pino';
import { MediaService } from '../../modules/media/media.service';
import type { RouteConstraint } from '../../modules/provider/provider.router';
import type { VoiceLab } from '../../modules/provider/adapters/voice-lab';
import type { PresenterLab } from '../../modules/provider/adapters/presenter-lab';
import { copyPipeline } from './copy';
import { musicPipeline } from './music';
import { voiceoverPipeline } from './voiceover';
import { dubPipeline } from './dub';
import { lipsyncPipeline } from './lipsync';
import { brandedImagePipeline } from './image';
import { productShotPipeline } from './product-shot';
import { collagePipeline } from './collage';
import { batchPipeline } from './batch';
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
    opts: {
      timeoutMs: number;
      signal: AbortSignal;
      onProgress?: (detail: string, progress?: number) => void;
      /**
       * Ask a different vendor than the default ranking would. A pipeline
       * that has just watched a model mangle the customer's product has
       * information the router does not, and asking that same model again is
       * the one thing least likely to work. Honoured on a best-effort basis:
       * if the constraint leaves nobody, the original candidates stand.
       */
      route?: RouteConstraint;
    },
  ) => Promise<ProviderResult>;
  /** Route and call a DIFFERENT capability — a pipeline that cuts out before it edits, or records before it lip-syncs. */
  callCapability: (
    capability: Capability,
    input: Omit<ProviderInput, 'config' | 'capability'>,
    opts: { timeoutMs: number; signal: AbortSignal; onProgress?: (detail: string, progress?: number) => void; route?: RouteConstraint },
  ) => Promise<ProviderResult>;
  stage: (stage: GenerationStage, progress: number, detail?: string) => Promise<void>;
  /** The adapter behind a VoiceProfile's providerKey, when it can clone and convert voices; null otherwise. */
  voiceLab: (providerKey: string) => VoiceLab | null;
  /** The adapter that can put a person on camera for a vendor name ("heygen"); null when it is not configured. */
  presenterLab: (vendor: string) => PresenterLab | null;
  /**
   * Journal a paid side-door call (currently presenter video) that is not a
   * routable capability, with the same submit/resume guarantees as adapters.
   */
  callExternal: <T>(
    provider: GenerationProvider,
    input: Omit<ProviderInput, 'config'>,
    execute: (opts: ProviderOpts) => Promise<T>,
    opts: Pick<ProviderOpts, 'timeoutMs' | 'signal' | 'onProgress'> & {
      /** Known vendor spend for this non-routable operation. */
      costMinor?: number | ((result: T) => number);
    },
  ) => Promise<T>;
}

export interface PipelineResult {
  artifacts: ProviderArtifact[];
  /** Outputs the pipeline already stored itself (a vaulted song); described here, not uploaded again. */
  extraOutputs?: GenerationOutput[];
  /** A parent that dispatched children and steps aside; the runner leaves it RUNNING at stage 'waiting'. */
  waiting?: boolean;
  providerKey?: string;
  providerJobId?: string;
  /** Spend already captured on child generations and rolled into this parent. */
  inheritedCostMinor?: number;
  /** Adapter-facing subtotal retained for pipeline tests/logs; the runner uses
   * the durable provider-attempt journal instead so retries are never lost or
   * counted twice. */
  costMinor?: number;
}

export type Pipeline = (ctx: PipelineContext) => Promise<PipelineResult>;

/** One provider call, its artifacts returned as they are. */
export const passthrough: Pipeline = async (ctx) => {
  const result = await ctx.callProvider(
    {
      generationId: ctx.row.id,
      workspaceId: ctx.row.workspaceId,
      capability: ctx.row.capability,
      params: ctx.row.input as Record<string, unknown>,
      files: ctx.files,
    },
    { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('generating', progress ?? 40, detail) },
  );
  return { artifacts: result.artifacts, providerKey: result.providerKey, providerJobId: result.providerJobId, costMinor: result.costMinor };
};

@Injectable()
export class Pipelines {
  private readonly byCapability: Partial<Record<Capability, Pipeline>> = {
    TEXT_GENERATE: copyPipeline,
    IMAGE_EDIT: brandedImagePipeline,
    PRODUCT_SHOT: productShotPipeline,
    COLLAGE: collagePipeline,
    BATCH: batchPipeline,
    MUSIC: musicPipeline,
    VOICEOVER: voiceoverPipeline,
    DUB: dubPipeline,
    LIPSYNC: lipsyncPipeline,
  };

  run(ctx: PipelineContext): Promise<PipelineResult> {
    // A multi-shot video is a plan, not a call. Its children are ordinary single-shot rows.
    if (ctx.row.capability === 'IMAGE_TO_VIDEO' && ctx.row.kind === 'PARENT') return adPipeline(ctx);
    const pipeline = this.byCapability[ctx.row.capability] ?? passthrough;
    return pipeline(ctx);
  }
}
