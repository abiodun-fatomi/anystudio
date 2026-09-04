/**
 * The runner: one generation, from QUEUED to a terminal state.
 *
 * THE SHAPE OF A RUN
 * ------------------
 *   claim the row (QUEUED → RUNNING, or drop the job — someone else has it)
 *   heartbeat on a timer for as long as we hold it
 *   narrate: preparing → routing → generating → composing → storing → done
 *   resolve inputs (storage keys → signed URLs the vendor can fetch)
 *   route → try candidates in order → the pipeline's post-processing
 *   store outputs, record them, succeed
 *   on failure: classify, then retry / fall back / fail-and-refund
 *
 * WHAT A FAILURE MEANS
 * --------------------
 * The five ProviderError kinds decide it. CONTENT_REJECTED and INVALID_INPUT
 * end the run at once — retrying would not change the input. RETRYABLE,
 * RATE_LIMITED and PROVIDER_DOWN move to the next candidate; if every
 * candidate is exhausted and attempts remain, the row goes back to QUEUED
 * with a delay; when attempts are gone it FAILS and the credits come back.
 * Every one of those transitions is one log line that says which.
 *
 * TIMEOUTS ARE BUDGETS, NOT GUESSES
 * ---------------------------------
 * The per-capability budget is a ceiling on vendor time. The heartbeat keeps
 * the sweeper away while we are genuinely waiting; the budget is what stops
 * us waiting forever on a vendor that will never answer.
 */

import { Injectable } from '@nestjs/common';
import { PrismaClient, type Generation, type Workspace } from '@prisma/client';
import {
  ProviderError,
  type Capability,
  type GenerationOutput,
  type ProviderArtifact,
  type ProviderFile,
  type ProviderInput,
  type ProviderResult,
} from '@anystudio/shared';
import { logger } from '../../config/logger';
import { GenerationService } from '../modules/generation/generation.service';
import { GenerationEvents } from '../modules/generation/generation.events';
import { MediaService } from '../modules/media/media.service';
import { ProviderRouter, type RouteCandidate } from '../modules/provider/provider.router';
import { QueueService } from '../modules/queue/queue.service';
import { fetchBytes } from '../modules/provider/adapters/http';
import { Pipelines, type PipelineContext } from './pipelines';
import { storeArtifacts } from './outputs';

/** Vendor-time ceiling per capability. Generous where GPUs are involved. */
export const BUDGET_MS: Record<Capability, number> = {
  IMAGE_GENERATE: 120_000,
  IMAGE_EDIT: 120_000,
  BACKGROUND_REMOVE: 60_000,
  BACKGROUND_REPLACE: 120_000,
  RELIGHT: 90_000,
  UPSCALE: 120_000,
  IMAGE_TO_VIDEO: 8 * 60_000,
  VIDEO_STITCH: 5 * 60_000,
  TEXT_GENERATE: 60_000,
  VOICEOVER: 90_000,
  MUSIC: 6 * 60_000,
  DUB: 12 * 60_000,
  LIPSYNC: 12 * 60_000,
};

const MAX_ATTEMPTS = 3;
const HEARTBEAT_MS = 20_000;
const RETRY_DELAY_MS = [0, 15_000, 60_000];

export type RunOutcome = 'succeeded' | 'failed' | 'requeued' | 'skipped';

@Injectable()
export class GenerationRunner {
  constructor(
    private readonly db: PrismaClient,
    private readonly generations: GenerationService,
    private readonly events: GenerationEvents,
    private readonly media: MediaService,
    private readonly router: ProviderRouter,
    private readonly queue: QueueService,
    private readonly pipelines: Pipelines,
  ) {}

  async run(generationId: string): Promise<RunOutcome> {
    const row = await this.generations.start(generationId);
    if (!row) {
      logger.debug({ generationId }, 'job dropped: row is not QUEUED (already running, finished, or gone)');
      return 'skipped';
    }
    const log = logger.child({ generationId, workspaceId: row.workspaceId, capability: row.capability, attempt: row.attempts });
    log.info({ costCode: row.costCode, credits: row.credits, kind: row.kind, parentId: row.parentId }, 'generation started');

    const heartbeat = setInterval(() => void this.generations.heartbeat(generationId), HEARTBEAT_MS);
    const abort = new AbortController();
    const startedAt = Date.now();

    try {
      const workspace = await this.db.workspace.findUnique({ where: { id: row.workspaceId } });
      if (!workspace) throw new ProviderError('INVALID_INPUT', 'workspace missing', 'runner');

      await this.events.stage(generationId, 'preparing', 5);
      const files = await this.resolveFiles(row);

      await this.events.stage(generationId, 'routing', 10);
      const decision = await this.router.route(row.capability, workspace.type, { generationId });
      if (decision.candidates.length === 0) {
        throw new ProviderError('PROVIDER_DOWN', `no provider available for ${row.capability}: ${decision.excluded.map((e) => `${e.key} (${e.reason})`).join('; ')}`, 'router');
      }

      const brandKit = await this.db.brandKit.findUnique({ where: { workspaceId: row.workspaceId } });
      const ctx: PipelineContext = {
        row,
        workspace,
        brandKit,
        files,
        signal: abort.signal,
        budgetMs: BUDGET_MS[row.capability],
        log,
        callProvider: (input, opts) => this.callWithFallback(decision.candidates, input, { ...opts, generationId }, log),
        stage: (stage, progress, detail) => this.events.stage(generationId, stage, progress, detail),
        media: this.media,
      };

      await this.events.stage(generationId, 'generating', 15);
      const produced = await this.pipelines.run(ctx);

      await this.events.stage(generationId, 'storing', 90);
      const outputs = await storeArtifacts(this.media, row, produced.artifacts);
      for (const output of outputs) await this.events.publish({ type: 'output', generationId, output, at: new Date().toISOString() });

      const done = await this.generations.succeed(generationId, {
        providerKey: produced.providerKey,
        providerJobId: produced.providerJobId,
        providerCostMinor: produced.costMinor,
        outputs,
      });
      await this.events.publish({ type: 'done', generationId, status: 'SUCCEEDED', at: new Date().toISOString() });
      log.info({ providerKey: done.providerKey, outputs: outputs.length, elapsedMs: Date.now() - startedAt, providerCostMinor: produced.costMinor }, 'generation succeeded');
      return 'succeeded';
    } catch (err) {
      return this.handleFailure(row, err, startedAt, log);
    } finally {
      clearInterval(heartbeat);
      abort.abort();
    }
  }

  /** Try each candidate in order; stop early on errors that retrying cannot fix. */
  private async callWithFallback(
    candidates: RouteCandidate[],
    input: Omit<ProviderInput, 'config'>,
    opts: { timeoutMs: number; signal: AbortSignal; onProgress?: (detail: string, progress?: number) => void; generationId: string },
    log: typeof logger,
  ): Promise<ProviderResult> {
    let last: ProviderError | undefined;
    for (const [i, c] of candidates.entries()) {
      const started = Date.now();
      const fullInput: ProviderInput = { ...input, config: { ...((c.row.config as Record<string, unknown> | null) ?? {}), costMinor: c.row.costPerCall } };
      try {
        log.info({ providerKey: c.row.key, candidate: i + 1, of: candidates.length }, 'calling provider');
        const result = await c.provider.generate(fullInput, opts);
        await this.router.report(c.row.key, input.capability, { ok: true, latencyMs: Date.now() - started }, { generationId: opts.generationId });
        log.info({ providerKey: c.row.key, latencyMs: Date.now() - started, providerJobId: result.providerJobId, artifacts: result.artifacts.length }, 'provider answered');
        return { ...result, costMinor: result.costMinor ?? c.row.costPerCall };
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError('RETRYABLE', `${c.row.key}: ${err instanceof Error ? err.message : String(err)}`, c.row.key);
        last = pe;
        await this.router.report(c.row.key, input.capability, { ok: false, kind: pe.kind, latencyMs: Date.now() - started }, { generationId: opts.generationId });
        if (!pe.retryable) {
          log.warn({ providerKey: c.row.key, kind: pe.kind, err: pe.message }, 'provider refused; not trying another — the input is the problem');
          throw pe;
        }
        if (i < candidates.length - 1) {
          log.warn({ providerKey: c.row.key, kind: pe.kind, err: pe.message, next: candidates[i + 1]!.row.key }, 'provider failed; falling back to the next candidate');
        } else {
          log.warn({ providerKey: c.row.key, kind: pe.kind, err: pe.message }, 'provider failed; no candidates left');
        }
      }
    }
    throw last ?? new ProviderError('PROVIDER_DOWN', 'no candidates', 'router');
  }

  /** Storage keys in the params → signed URLs the vendor can fetch. */
  private async resolveFiles(row: Generation): Promise<Record<string, ProviderFile>> {
    const files: Record<string, ProviderFile> = {};
    const params = row.input as Record<string, unknown>;
    const add = async (name: string, key: string) => {
      const asset = await this.db.mediaAsset.findUnique({ where: { key } });
      files[name] = { url: await this.media.signRead(key, 60 * 60), mime: asset?.mime ?? 'application/octet-stream', bytes: asset?.bytes ?? undefined };
    };
    for (const [name, value] of Object.entries(params)) {
      if (name.endsWith('Key') && typeof value === 'string') await add(name, value);
      if (name.endsWith('Keys') && Array.isArray(value)) for (const [i, key] of (value as string[]).entries()) await add(`${name}[${i}]`, key);
    }
    return files;
  }

  private async handleFailure(row: Generation, err: unknown, startedAt: number, log: typeof logger): Promise<RunOutcome> {
    const pe = err instanceof ProviderError ? err : null;
    const kind = pe?.kind ?? (err instanceof Error && /timeout|aborted/i.test(err.message) ? 'TIMEOUT' : 'INTERNAL');
    const reason = err instanceof Error ? err.message : String(err);
    const elapsedMs = Date.now() - startedAt;
    const canRetry = (pe ? pe.retryable : kind === 'TIMEOUT') && row.attempts < MAX_ATTEMPTS;

    if (canRetry) {
      const delayMs = RETRY_DELAY_MS[Math.min(row.attempts, RETRY_DELAY_MS.length - 1)]!;
      await this.generations.requeue(row.id, reason);
      await this.queue.enqueue(row.id, row.capability, { delayMs });
      log.warn({ kind, err: reason, elapsedMs, retryInMs: delayMs, attemptsLeft: MAX_ATTEMPTS - row.attempts }, 'generation requeued for another attempt');
      return 'requeued';
    }

    try {
      await this.generations.fail(row.id, { failureReason: reason.slice(0, 2000), failureKind: kind, providerKey: pe?.providerKey, providerJobId: pe?.meta.providerJobId });
    } catch (failErr) {
      // Already terminal (a sweeper or a late webhook got there first). Nothing to refund twice.
      log.warn({ err: failErr instanceof Error ? failErr.message : failErr }, 'could not mark generation failed; it was already terminal');
      return 'skipped';
    }
    await this.events.publish({ type: 'done', generationId: row.id, status: 'FAILED', at: new Date().toISOString() });
    const level = kind === 'CONTENT_REJECTED' ? 'info' : kind === 'INVALID_INPUT' || kind === 'INTERNAL' ? 'error' : 'warn';
    log[level]({ kind, err: reason, elapsedMs, attempts: row.attempts, credits: row.credits, providerKey: pe?.providerKey, raw: pe?.meta.raw }, 'generation FAILED; credits refunded');
    return 'failed';
  }
}

export { fetchBytes };
export type { ProviderArtifact, GenerationOutput, Workspace };
