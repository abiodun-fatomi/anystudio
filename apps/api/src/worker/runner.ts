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
 * ProviderError kinds decide it. CONTENT_REJECTED and REQUEST_REJECTED end
 * the run at once — retrying would not change the input. INVALID_INPUT is a
 * locally detected adapter defect and may use an unpaid fallback. RETRYABLE,
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
  DUB_VENDOR_KEYS,
  ProviderError,
  dubLanguage,
  dubVendorsFor,
  type Capability,
  type CapabilityParams,
  type GenerationOutput,
  type GenerationProvider,
  type ProviderArtifact,
  type ProviderFile,
  type ProviderInput,
  type ProviderOpts,
  type ProviderResult,
} from '@anystudio/shared';
import { logger } from '../../config/logger';
import { GenerationService, parentResumeCapability } from '../modules/generation/generation.service';
import { MAX_ATTEMPTS } from '../modules/generation/generation.types';
import { GenerationEvents } from '../modules/generation/generation.events';
import { MediaService } from '../modules/media/media.service';
import { ProviderRouter, type RouteCandidate, type RouteConstraint } from '../modules/provider/provider.router';
import { QueueService } from '../modules/queue/queue.service';
import { ProviderRegistry } from '../modules/provider/provider.registry';
import { isVoiceLab } from '../modules/provider/adapters/voice-lab';
import { isPresenterLab } from '../modules/provider/adapters/presenter-lab';
import { fetchBytes } from '../modules/provider/adapters/http';
import { Pipelines, type PipelineContext } from './pipelines';
import { ProviderAttemptJournal } from './provider-attempts';

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
import { storeArtifacts } from './outputs';

/** Vendor-time ceiling per capability. Generous where GPUs are involved. */
export const BUDGET_MS: Record<Capability, number> = {
  IMAGE_GENERATE: 120_000,
  IMAGE_EDIT: 120_000,
  BACKGROUND_REMOVE: 60_000,
  BACKGROUND_REPLACE: 120_000,
  RELIGHT: 90_000,
  UPSCALE: 120_000,
  COLLAGE: 120_000,
  PRODUCT_SHOT: 120_000,
  BATCH: 30 * 60_000, // a parent that waits on its children, holding no worker
  IMAGE_TO_VIDEO: 8 * 60_000,
  VIDEO_STITCH: 5 * 60_000,
  TEXT_GENERATE: 60_000,
  VOICEOVER: 90_000,
  MUSIC: 6 * 60_000,
  DUB: 12 * 60_000,
  LIPSYNC: 12 * 60_000,
};

const HEARTBEAT_MS = 20_000;
const RETRY_DELAY_MS = [0, 15_000, 60_000];

export type RunOutcome = 'succeeded' | 'failed' | 'requeued' | 'skipped' | 'waiting';

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
    private readonly registry: ProviderRegistry,
  ) {}

  async run(generationId: string): Promise<RunOutcome> {
    let resume = false;
    let row = await this.generations.start(generationId);
    if (!row) {
      // Not QUEUED. A waiting parent whose shots have all finished is the one legitimate reason to run again.
      row = await this.generations.resume(generationId);
      if (row) resume = true;
    }
    if (!row) {
      logger.debug({ generationId }, 'job dropped: row is not QUEUED (already running, finished, or gone)');
      return 'skipped';
    }
    const log = logger.child({ generationId, workspaceId: row.workspaceId, capability: row.capability, attempt: row.attempts });
    log.info({ costCode: row.costCode, credits: row.credits, kind: row.kind, parentId: row.parentId }, 'generation started');

    const heartbeat = setInterval(() => {
      void this.generations.heartbeat(generationId);
      if (row!.parentId) void this.generations.touchParent(generationId); // a child alive means its parent is alive
    }, HEARTBEAT_MS);
    const abort = new AbortController();
    const startedAt = Date.now();
    const providerAttempts = new ProviderAttemptJournal(this.db, generationId, row.attempts);
    // Local/stub providers deliberately have no durable attempt row. They cost
    // nothing in production, but keeping their declared cost makes development
    // fixtures and any future in-house metered adapter account honestly.
    let unjournaledCostMinor = 0;
    const knownProviderCost = async () => (await providerAttempts.totalCostMinor()) + unjournaledCostMinor;

    try {
      const workspace = await this.db.workspace.findUnique({ where: { id: row.workspaceId } });
      if (!workspace) throw new ProviderError('INVALID_INPUT', 'workspace missing', 'runner');

      await this.events.stage(generationId, 'preparing', 5);
      const files = await this.resolveFiles(row);

      await this.events.stage(generationId, 'routing', 10);
      // Route lazily, when a pipeline actually asks for its primary provider.
      // COLLAGE and BATCH are local orchestration, and an IMAGE_TO_VIDEO parent
      // only plans/dispatches or stitches already-finished children. Requiring a
      // vendor for those parent rows prevented their own pipelines from running
      // in production (where the development stub is deliberately absent).
      let primaryDecision: Awaited<ReturnType<ProviderRouter['route']>> | null = null;
      const routePrimary = async () => {
        if (primaryDecision) return primaryDecision;
        const constraint = await this.routingConstraint(row);
        const decision = await this.router.route(row.capability, workspace.type, { generationId, ...constraint });
        primaryDecision = decision;
        return decision;
      };

      const brandKit = await this.db.brandKit.findUnique({ where: { workspaceId: row.workspaceId } });
      const ctx: PipelineContext = {
        row,
        workspace,
        brandKit,
        files,
        signal: abort.signal,
        budgetMs: BUDGET_MS[row.capability],
        log,
        callProvider: async (input, opts) => {
          const operationKey = providerAttempts.nextOperation(input);
          // A pipeline may ask to steer away from a vendor it has just seen
          // fail on quality rather than on errors — something the router
          // cannot know, because the call SUCCEEDED. If steering leaves no
          // one, the original ranking stands: a second-best vendor beats no
          // picture at all.
          let candidates = (await routePrimary()).candidates;
          if (opts.route) {
            const steered = await this.router.route(row.capability, workspace.type, { generationId, ...opts.route });
            if (steered.candidates.length > 0) candidates = steered.candidates;
            else log.warn({ route: opts.route }, 'nobody left after steering; keeping the original candidates');
          }
          return this.callWithFallback(
            candidates,
            input,
            { ...opts, generationId, operationKey, providerAttempts, onUnjournaledCost: (cost) => (unjournaledCostMinor += cost) },
            log,
          );
        },
        callCapability: async (capability, input, opts) => {
          const providerInput = { ...input, capability };
          const operationKey = providerAttempts.nextOperation(providerInput);
          const d = await this.router.route(capability, workspace.type, { generationId, ...(opts.route ?? {}) });
          return this.callWithFallback(
            d.candidates,
            providerInput,
            { ...opts, generationId, operationKey, providerAttempts, onUnjournaledCost: (cost) => (unjournaledCostMinor += cost) },
            log,
          );
        },
        stage: (stage, progress, detail) => this.events.stage(generationId, stage, progress, detail),
        voiceLab: (providerKey) => {
          const p = this.registry.get(providerKey);
          return isVoiceLab(p) ? p : null;
        },
        presenterLab: (vendor) => {
          const p = this.registry
            .keys()
            .map((k) => this.registry.get(k))
            .find((a) => a && a.key.startsWith(`${vendor}:`) && isPresenterLab(a));
          return isPresenterLab(p) ? p : null;
        },
        callExternal: (provider, input, execute, opts) => this.callExternal(providerAttempts, provider, workspace.type, input, execute, opts, log),
        media: this.media,
        db: this.db,
        generations: this.generations,
        resume,
      };

      await this.events.stage(generationId, resume ? 'composing' : 'generating', resume ? 60 : 15);
      const produced = await this.pipelines.run(ctx);

      if (produced.waiting) {
        await this.generations.wait(generationId);
        await this.events.stage(generationId, 'waiting', 20, 'shots are rendering');
        log.info({ elapsedMs: Date.now() - startedAt }, 'parent dispatched its shots and stepped aside');
        return 'waiting';
      }

      await this.events.stage(generationId, 'storing', 90);
      const outputs = [...(await storeArtifacts(this.media, row, produced.artifacts, abort.signal)), ...(produced.extraOutputs ?? [])];
      const providerCostMinor = (await knownProviderCost()) + (produced.inheritedCostMinor ?? 0);

      // A finished shot moves its parent's bar and names the next one, so a
      // five-minute wait shows progress instead of one frozen sentence.
      if (row.parentId) void this.reportShots(row.parentId);

      const done = await this.generations.succeed(generationId, {
        providerKey: produced.providerKey,
        providerJobId: produced.providerJobId,
        providerCostMinor,
        outputs,
      });
      // Publish keys only after the generation commits them. Customer-facing
      // media signing requires this link, so an output event can never race a
      // READY-but-not-yet-owned object (or expose a failed/refunded artifact).
      for (const output of outputs)
        await this.events.publish({ type: 'output', generationId, output: output.locked ? { ...output, key: '' } : output, at: new Date().toISOString() });
      await this.events.publish({ type: 'done', generationId, status: 'SUCCEEDED', at: new Date().toISOString() });
      log.info({ providerKey: done.providerKey, outputs: outputs.length, elapsedMs: Date.now() - startedAt, providerCostMinor }, 'generation succeeded');
      return 'succeeded';
    } catch (err) {
      let providerCostMinor = 0;
      try {
        providerCostMinor = await knownProviderCost();
        if (row.kind === 'PARENT') {
          const children = await this.db.generation.aggregate({ where: { parentId: row.id }, _sum: { providerCostMinor: true } });
          providerCostMinor += children._sum.providerCostMinor ?? 0;
        }
      } catch (costErr) {
        log.warn({ err: costErr }, 'could not total known provider spend while handling failure');
      }
      return this.handleFailure(row, err, startedAt, log, providerCostMinor);
    } finally {
      clearInterval(heartbeat);
      abort.abort();
      if (row.parentId) await this.wakeParent(row.parentId, generationId, log);
    }
  }

  /**
   * A shot finished (or failed for good). Tell the parent's stream, and if
   * every sibling is terminal, put the parent back on the queue to assemble.
   * The parent's `resume()` claim is conditional, so two shots finishing in
   * the same instant cannot both wake it.
   */
  private async wakeParent(parentId: string, childId: string, log: typeof logger): Promise<void> {
    const siblings = await this.db.generation.findMany({ where: { parentId }, select: { id: true, status: true } });
    const done = siblings.filter((s) => (TERMINAL as readonly string[]).includes(s.status)).length;
    await this.events
      .stage(parentId, 'waiting', Math.round(20 + (done / Math.max(1, siblings.length)) * 40), `shot ${done} of ${siblings.length} done`)
      .catch(() => undefined);
    if (done < siblings.length) return;
    const parent = await this.db.generation.findUnique({ where: { id: parentId }, select: { status: true, stage: true, capability: true } });
    if (parent?.status === 'RUNNING' && parent.stage === 'waiting') {
      const queuedCapability = parentResumeCapability(parent.capability);
      await this.queue.enqueue(parentId, queuedCapability);
      log.info({ parentId, childId, shots: siblings.length, queueCapability: queuedCapability }, 'last shot finished; parent queued to assemble');
    }
  }

  /** Try each candidate in order; stop early on errors that retrying cannot fix. */
  /**
   * What the request itself says about who may serve it.
   *
   * A voice belongs to one vendor: when the row names a voice, only that
   * vendor's row may serve it — a fallback would read the script in a
   * different person's voice, which is worse than failing.
   *
   * A dub goes to a vendor that speaks the language: the ones known not to
   * are excluded, and when the seller wants the lips moved too, the vendor
   * that does both in one pass is tried first.
   */
  private async routingConstraint(row: Generation): Promise<RouteConstraint> {
    if (row.capability === 'VOICEOVER') {
      const voiceId = (row.input as { voiceId?: string }).voiceId;
      if (!voiceId) return {};
      return { only: await this.vendorForVoice(voiceId, row.workspaceId) };
    }
    if (row.capability === 'DUB') {
      const p = row.input as CapabilityParams<'DUB'>;
      const { can, cannot } = dubVendorsFor(p.targetLanguage);
      if (!dubLanguage(p.targetLanguage)) throw new ProviderError('INVALID_INPUT', `"${p.targetLanguage}" is not a language we can dub into`, 'runner');
      return { exclude: cannot, prefer: p.lipsync ? [DUB_VENDOR_KEYS.heygen, ...can] : can };
    }
    return {};
  }

  /** The vendor that holds a voice. A workspace's own voice is nobody else's: another workspace asking for it gets "unknown". */
  /** Tell the parent's card how many of its shots are in. Best effort: a lost update is a stale line, not a lost ad. */
  private async reportShots(parentId: string): Promise<void> {
    try {
      const p = await this.generations.shotProgress(parentId);
      if (p) await this.events.stage(parentId, 'waiting', p.progress, p.detail);
    } catch (err) {
      logger.debug({ err, parentId }, 'could not report shot progress');
    }
  }

  private async vendorForVoice(voiceId: string, workspaceId: string): Promise<string> {
    const voice = await this.db.voiceProfile.findUnique({
      where: { key: voiceId },
      select: { providerKey: true, active: true, kind: true, workspaceId: true },
    });
    if (!voice?.active || (voice.kind === 'CLONE' && voice.workspaceId !== workspaceId))
      throw new ProviderError('INVALID_INPUT', `unknown voice "${voiceId}"`, 'runner');
    return voice.providerKey;
  }

  private async callWithFallback(
    candidates: RouteCandidate[],
    input: Omit<ProviderInput, 'config'>,
    opts: {
      timeoutMs: number;
      signal: AbortSignal;
      onProgress?: (detail: string, progress?: number) => void;
      generationId: string;
      operationKey?: string;
      providerAttempts?: ProviderAttemptJournal;
      onUnjournaledCost?: (costMinor: number) => void;
    },
    log: typeof logger,
  ): Promise<ProviderResult> {
    let last: ProviderError | undefined;
    const outstanding =
      opts.providerAttempts && opts.operationKey ? await opts.providerAttempts.outstanding(opts.operationKey, this.registry, candidates) : null;
    // An accepted job is the only candidate until it settles. This remains
    // true when a breaker opened or routing priorities changed after submit.
    const serving = outstanding ? [outstanding] : candidates;
    if (serving.length === 0) throw new ProviderError('PROVIDER_DOWN', `no provider available for ${input.capability}`, 'router');
    // A capability's timeout is one wall-clock budget, not a fresh allowance
    // for every fallback. Without a shared deadline, three eight-minute video
    // candidates could keep one generation alive for twenty-four minutes even
    // though IMAGE_TO_VIDEO's advertised ceiling is eight.
    const deadline = Date.now() + Math.max(0, opts.timeoutMs);
    for (const [i, c] of serving.entries()) {
      const remainingMs = Math.floor(deadline - Date.now());
      if (remainingMs <= 0) {
        throw new ProviderError('RETRYABLE', `provider fallback budget exhausted after ${opts.timeoutMs}ms`, 'runner', {
          raw: { lastProviderKey: last?.providerKey },
        });
      }
      const started = Date.now();
      const fullInput: ProviderInput = { ...input, config: { ...((c.row.config as Record<string, unknown> | null) ?? {}), costMinor: c.row.costPerCall } };
      const attemptAbort = new AbortController();
      const onParentAbort = () => attemptAbort.abort(opts.signal.reason);
      if (opts.signal.aborted) onParentAbort();
      else opts.signal.addEventListener('abort', onParentAbort, { once: true });
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const journaled = Boolean(opts.providerAttempts && opts.operationKey) && !c.row.key.startsWith('local:') && !c.row.key.startsWith('stub:');
      let attempt: Awaited<ReturnType<ProviderAttemptJournal['begin']>> | undefined;
      const deadlineReached = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          attemptAbort.abort(new Error(`provider budget exhausted after ${opts.timeoutMs}ms`));
          reject(new ProviderError('RETRYABLE', `${c.row.key}: provider fallback budget exhausted after ${opts.timeoutMs}ms`, c.row.key));
        }, remainingMs);
      });
      try {
        attempt = journaled ? await opts.providerAttempts!.begin(opts.operationKey!, c) : undefined;
        // `for` names the capability actually being called. The bound logger
        // carries the JOB's capability, so a cutout taken on behalf of an
        // IMAGE_EDIT was logged as an IMAGE_EDIT call — which is exactly the
        // line you reach for when working out why an image came out wrong.
        // (The router was always told the right one; only the log lied.)
        log.info(
          { providerKey: c.row.key, for: input.capability, candidate: i + 1, of: serving.length, resumedJobId: attempt?.resume?.providerJobId },
          attempt?.resume ? 'resuming provider job' : 'calling provider',
        );
        // The remaining timeout is part of the adapter contract. The race is
        // the outer safety net for an adapter that accidentally uses a fixed
        // timeout in one of its internal HTTP steps; aborting also stops every
        // compliant adapter's in-flight request.
        const result = await Promise.race([
          c.provider.generate(fullInput, {
            timeoutMs: remainingMs,
            signal: attemptAbort.signal,
            onProgress: opts.onProgress,
            ...(attempt?.resume ? { resume: attempt.resume } : {}),
            ...(attempt
              ? {
                  onSubmitted: (providerJobId: string, data?: Record<string, unknown>) =>
                    opts.providerAttempts!.submitted(attempt!.row.id, c.row.key, providerJobId, data),
                  onSettled: (outcome: 'SUCCEEDED' | 'FAILED') => opts.providerAttempts!.settled(attempt!.row.id, outcome),
                }
              : {}),
          }),
          deadlineReached,
        ]);
        const costMinor = result.costMinor ?? c.row.costPerCall;
        if (attempt) await opts.providerAttempts!.settled(attempt.row.id, 'SUCCEEDED', undefined, costMinor);
        else opts.onUnjournaledCost?.(costMinor);
        await this.router.report(c.row.key, input.capability, { ok: true, latencyMs: Date.now() - started }, { generationId: opts.generationId });
        log.info(
          {
            providerKey: c.row.key,
            for: input.capability,
            latencyMs: Date.now() - started,
            providerJobId: result.providerJobId,
            artifacts: result.artifacts.length,
          },
          'provider answered',
        );
        return { ...result, costMinor };
      } catch (err) {
        const pe =
          err instanceof ProviderError ? err : new ProviderError('RETRYABLE', `${c.row.key}: ${err instanceof Error ? err.message : String(err)}`, c.row.key);
        last = pe;
        await this.router.report(
          c.row.key,
          input.capability,
          { ok: false, kind: pe.kind, latencyMs: Date.now() - started },
          { generationId: opts.generationId },
        );
        // Reporting the vendor outcome must happen before the journal guard:
        // for accepted jobs the guard intentionally throws to force a retry of
        // that same id, and an early throw would otherwise hide outages from
        // the circuit breaker.
        if (attempt) await opts.providerAttempts!.guardFailure(attempt.row, pe);
        // INVALID_INPUT is reserved for an adapter defect caught locally,
        // before a remote request or async job exists. That unpaid failure may
        // fall back. A vendor 4xx is REQUEST_REJECTED and always stops here;
        // the extra metadata checks fail closed if an old adapter mislabels a
        // remote response, preventing a second paid submission.
        const adapterDefect =
          pe.kind === 'INVALID_INPUT' && pe.providerKey === c.row.key && pe.meta.status === undefined && pe.meta.providerJobId === undefined;
        if (!pe.retryable && !adapterDefect) {
          log.warn({ providerKey: c.row.key, kind: pe.kind, err: pe.message }, 'provider refused; not trying another — the input is the problem');
          throw pe;
        }
        if (adapterDefect) log.error({ providerKey: c.row.key, err: pe.message }, 'adapter rejected its own request before submission — fix the adapter');
        if (i < serving.length - 1) {
          log.warn(
            { providerKey: c.row.key, kind: pe.kind, err: pe.message, next: serving[i + 1]!.row.key },
            'provider failed; falling back to the next candidate',
          );
        } else {
          log.warn({ providerKey: c.row.key, kind: pe.kind, err: pe.message }, 'provider failed; no candidates left');
        }
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        opts.signal.removeEventListener('abort', onParentAbort);
      }
    }
    throw last ?? new ProviderError('PROVIDER_DOWN', 'no candidates', 'router');
  }

  /** A paid adapter side-door with no router fallback (presenters, stems, voice conversion). */
  private async callExternal<T>(
    journal: ProviderAttemptJournal,
    provider: GenerationProvider,
    workspaceType: Workspace['type'],
    input: Omit<ProviderInput, 'config'>,
    execute: (opts: ProviderOpts) => Promise<T>,
    opts: Pick<ProviderOpts, 'timeoutMs' | 'signal' | 'onProgress'> & { costMinor?: number | ((result: T) => number) },
    log: typeof logger,
  ): Promise<T> {
    const operationKey = journal.nextOperation(input);
    // Resume an already-accepted operation even if an operator has since
    // disabled the provider. For a *new* paid POST, go through the ordinary
    // router so the kill switch, workspace row and circuit breaker all apply.
    const outstanding = await journal.outstanding(operationKey, this.registry, []);
    const decision = outstanding ? null : await this.router.route(input.capability, workspaceType, { generationId: input.generationId, only: provider.key });
    const current = outstanding ?? decision?.candidates.find((candidate) => candidate.row.key === provider.key);
    if (!current) throw new ProviderError('PROVIDER_DOWN', `${provider.key}: this external operation is disabled or unavailable`, provider.key);
    if (current.provider.key !== provider.key) {
      throw new ProviderError(
        'SUBMISSION_UNKNOWN',
        `${provider.key}: an accepted external operation belongs to ${current.provider.key}; refusing to poll it through another adapter`,
        provider.key,
      );
    }
    const row = current.row;
    let attempt: Awaited<ReturnType<ProviderAttemptJournal['begin']>> | undefined;
    const started = Date.now();
    try {
      attempt = await journal.begin(operationKey, current);
      log.info(
        { providerKey: provider.key, for: input.capability, resumedJobId: attempt.resume?.providerJobId },
        attempt.resume ? 'resuming external provider job' : 'calling external provider',
      );
      const result = await execute({
        ...opts,
        ...(attempt.resume ? { resume: attempt.resume } : {}),
        onSubmitted: (providerJobId, data) => journal.submitted(attempt!.row.id, provider.key, providerJobId, data),
        onSettled: (outcome) => journal.settled(attempt!.row.id, outcome),
      });
      const configuredCost = typeof opts.costMinor === 'function' ? opts.costMinor(result) : opts.costMinor;
      await journal.settled(attempt.row.id, 'SUCCEEDED', undefined, configuredCost ?? row.costPerCall);
      await this.router.report(row.key, row.capability, { ok: true, latencyMs: Date.now() - started }, { generationId: input.generationId });
      return result;
    } catch (err) {
      const pe =
        err instanceof ProviderError ? err : new ProviderError('RETRYABLE', `${provider.key}: ${err instanceof Error ? err.message : err}`, provider.key);
      await this.router.report(row.key, row.capability, { ok: false, kind: pe.kind, latencyMs: Date.now() - started }, { generationId: input.generationId });
      if (attempt) await journal.guardFailure(attempt.row, pe);
      throw pe;
    }
  }

  /** Storage keys in the params → signed URLs the vendor can fetch. */
  private async resolveFiles(row: Generation): Promise<Record<string, ProviderFile>> {
    const files: Record<string, ProviderFile> = {};
    const params = row.input as Record<string, unknown>;
    const add = async (name: string, key: string) => {
      const asset = await this.db.mediaAsset.findUnique({ where: { key } });
      files[name] = { key, url: await this.media.signRead(key, 60 * 60), mime: asset?.mime ?? 'application/octet-stream', bytes: asset?.bytes ?? undefined };
    };
    for (const [name, value] of Object.entries(params)) {
      if (name.endsWith('Key') && typeof value === 'string') await add(name, value);
      if (name.endsWith('Keys') && Array.isArray(value)) for (const [i, key] of (value as string[]).entries()) await add(`${name}[${i}]`, key);
    }
    return files;
  }

  private async handleFailure(row: Generation, err: unknown, startedAt: number, log: typeof logger, providerCostMinor?: number): Promise<RunOutcome> {
    const pe = err instanceof ProviderError ? err : null;
    const kind = pe?.kind ?? (err instanceof Error && /timeout|aborted/i.test(err.message) ? 'TIMEOUT' : 'INTERNAL');
    const reason = err instanceof Error ? err.message : String(err);
    const elapsedMs = Date.now() - startedAt;
    const canRetry = (pe ? pe.retryable : kind === 'TIMEOUT') && row.attempts < MAX_ATTEMPTS;

    if (canRetry) {
      const delayMs = RETRY_DELAY_MS[Math.min(row.attempts, RETRY_DELAY_MS.length - 1)]!;
      let queuedCapability = row.capability;
      const reset =
        row.kind === 'PARENT' && row.stage === 'composing'
          ? await this.generations.retryParentAssembly(row.id, reason)
          : await this.generations.requeue(row.id, reason);
      if (!reset) {
        log.warn({ kind, err: reason }, 'generation retry lost a state transition race');
        return 'skipped';
      }
      // A resumed ad is now pure ffmpeg work; a resumed batch is still cheap
      // orchestration. Preserve that distinction on every assembly retry.
      if (row.kind === 'PARENT' && row.stage === 'composing') queuedCapability = parentResumeCapability(row.capability);
      await this.queue.enqueue(row.id, queuedCapability, { delayMs });
      log.warn(
        { kind, err: reason, elapsedMs, queuedCapability, retryInMs: delayMs, attemptsLeft: MAX_ATTEMPTS - row.attempts },
        'generation requeued for another attempt',
      );
      return 'requeued';
    }

    try {
      await this.generations.fail(row.id, {
        failureReason: reason.slice(0, 2000),
        failureKind: kind,
        providerKey: pe?.providerKey,
        providerJobId: pe?.meta.providerJobId,
        ...(providerCostMinor !== undefined ? { providerCostMinor } : {}),
      });
    } catch (failErr) {
      // Already terminal (a sweeper or a late webhook got there first). Nothing to refund twice.
      log.warn({ err: failErr instanceof Error ? failErr.message : failErr }, 'could not mark generation failed; it was already terminal');
      return 'skipped';
    }
    await this.events.publish({ type: 'done', generationId: row.id, status: 'FAILED', at: new Date().toISOString() });
    const level = kind === 'CONTENT_REJECTED' || kind === 'REQUEST_REJECTED' ? 'info' : kind === 'INVALID_INPUT' || kind === 'INTERNAL' ? 'error' : 'warn';
    log[level](
      { kind, err: reason, elapsedMs, attempts: row.attempts, credits: row.credits, providerKey: pe?.providerKey, raw: pe?.meta.raw },
      'generation FAILED; credits refunded',
    );
    return 'failed';
  }
}

export { fetchBytes };
export type { ProviderArtifact, GenerationOutput, Workspace };
