/**
 * The lifecycle of a generation, and the money attached to it.
 *
 * THE ORDERING THAT MATTERS
 * -------------------------
 * `request()` writes the row and debits the credits in ONE transaction, before
 * anything is queued and long before a provider is called. Everything after
 * that is a state transition on a row that already exists and is already paid
 * for. The queue carries an id and nothing else.
 *
 * Do it the other way round — queue first, charge later — and every failure
 * between the two becomes a customer who was charged for nothing, or a
 * generation nobody paid for. Neither is recoverable from the outside, because
 * there is no record of what was supposed to happen.
 *
 * CREDITS ARE HELD, NOT SPENT
 * ---------------------------
 * The debit is a reservation. `fail()` and `cancel()` refund it; `succeed()`
 * simply lets it stand. Both go through LedgerService, which goes through the
 * `ledger_apply` Postgres function — this service never touches ledger rows.
 *
 * Refunds reuse the debit's idempotency key with a `:refund` suffix, so a
 * generation that somehow fails twice refunds exactly once.
 *
 * EVERY TRANSITION IS GUARDED
 * ---------------------------
 * A row already in a terminal state is never moved again. That is what stops
 * the two ways money leaks here: a retried failure refunding twice, and a
 * late provider success un-refunding a generation the customer was already
 * paid back for.
 */

import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { validateUpscaleSize } from './upscale-limits';
import { Prisma, PrismaClient, type Generation, type MediaAsset } from '@prisma/client';
import {
  BATCH_MAX,
  CAPABILITIES,
  COPY_FIELDS,
  CUSTOMER_MESSAGE,
  DEFAULT_COST_CODE,
  DUB_LIPSYNC_COST_CODE,
  DUB_MAX_SEC,
  LIPSYNC_MAX_SEC,
  MUSIC_MY_VOICE_COST_CODE,
  presenterCostCode,
  dubLanguage,
  generationDebitKey,
  isCapability,
  parseCapabilityParams,
  shotPlanSchema,
  withoutPipelineFields,
  redactLocked,
  type Capability,
  type GenerationOutput,
  type ProviderErrorKind,
  type ShotPlan,
  adPlan,
  batchUnitCostCode,
  productShotCostCode,
} from '@anystudio/shared';
import { EXPECTED_MS } from '../provider/adapters/base';
import { GenerationHooks } from './generation.hooks';
import { LedgerService } from '../ledger/ledger.service';
import { MediaService } from '../media/media.service';
import { QueueService } from '../queue/queue.service';
import { ConflictError, CreditLineError, InsufficientCreditsError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import {
  MAX_ATTEMPTS,
  QUEUED_STALE_AFTER_MS,
  STALE_AFTER_MS,
  TERMINAL_STATUSES,
  type GenerationOutcome,
  type GenerationRequest,
  type GenerationResult,
  type GenerationView,
} from './generation.types';

/** A QUEUED row this old with no job behind it is re-dispatched by the worker. */
export const DISPATCH_AFTER_MS = 20 * 1000;

const VIDEO_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(['IMAGE_TO_VIDEO', 'VIDEO_STITCH', 'DUB', 'LIPSYNC']);
/** Parents and standalone videos per workspace per rolling day. Operators raise it per customer, not globally. */
const VIDEO_DAILY_LIMIT = Number(process.env.VIDEO_DAILY_LIMIT ?? 20);

/**
 * The queue capability for a parent's second pass.
 *
 * IMAGE_TO_VIDEO becomes local ffmpeg work once its children finish. BATCH
 * only gathers child outputs and refunds failed shares, so it stays on the
 * fast orchestration queue. Keeping this decision in one place prevents a
 * generic "parent" branch from sending every parent to the media worker.
 */
export function parentResumeCapability(capability: Capability): Capability {
  return capability === 'IMAGE_TO_VIDEO' ? 'VIDEO_STITCH' : capability;
}

/**
 * Resolve one of the finite server-owned price codes from capability params.
 *
 * `request()` calls this only after schema validation. `quote()` also uses it
 * for an unfinished form, where missing selectors intentionally fall back to
 * the capability default. No branch ever returns a string supplied as a price
 * code by the caller.
 */
export function generationCostCode(capability: Capability, params: Record<string, unknown>): string {
  // Keep the existing Enhance price when moving it from enlargement to local photo correction.
  if (capability === 'IMAGE_EDIT' && params.restyle === 'enhance') return DEFAULT_COST_CODE.UPSCALE;
  if (capability === 'BATCH') {
    if (!isCapability(params.of)) return DEFAULT_COST_CODE.BATCH;
    const unitParams =
      params.params !== null && typeof params.params === 'object' && !Array.isArray(params.params) ? (params.params as Record<string, unknown>) : {};
    return batchUnitCostCode(params.of, unitParams);
  }
  if (capability === 'PRODUCT_SHOT') return productShotCostCode(params.mode as string, params.shotSize as string);
  // An instrumental has no singer to replace. Treating the otherwise-ignored
  // singer selector as a premium would charge for stems/conversion we never run.
  if (capability === 'MUSIC' && params.singer === 'me' && params.vocal !== 'instrumental') return MUSIC_MY_VOICE_COST_CODE;
  if (capability === 'TEXT_GENERATE' && params.task === 'field') return 'text.caption';
  if (capability === 'DUB' && params.lipsync === true) return DUB_LIPSYNC_COST_CODE;
  if (capability === 'IMAGE_TO_VIDEO') {
    const shots = Number(params.shots ?? 1);
    const plan = adPlan(shots);
    if (!plan) return DEFAULT_COST_CODE[capability];
    const withPresenter = shots > 1 && params.format === 'ugc' && params.presenter !== null && typeof params.presenter === 'object';
    return withPresenter ? presenterCostCode(plan.costCode) : plan.costCode;
  }
  return DEFAULT_COST_CODE[capability];
}

/** Number of independently billable outputs or duration blocks. */
export function generationQuantity(capability: Capability, params: Record<string, unknown>, sourceDurationMs?: number): number {
  if (capability === 'BATCH') return Math.max(1, Math.min(BATCH_MAX, Array.isArray(params.sourceKeys) ? params.sourceKeys.length : 1));
  if (capability === 'IMAGE_GENERATE') {
    const count = Number(params.count ?? 1);
    return Number.isInteger(count) ? Math.max(1, Math.min(4, count)) : 1;
  }
  if (capability === 'MUSIC') {
    // Match capabilityParams.MUSIC's default so an unfinished quote and the
    // eventual parsed request cannot disagree about the number of units.
    const durationSec = Number(params.durationSec ?? 120);
    return Number.isFinite(durationSec) ? Math.max(1, Math.min(8, Math.ceil(durationSec / 30))) : 1;
  }
  if (capability === 'DUB') {
    const blockMs = params.lipsync === true ? 30_000 : 60_000;
    const maxBlocks = Math.ceil((DUB_MAX_SEC * 1000) / blockMs);
    const blocks = durationBlocks(sourceDurationMs, blockMs, maxBlocks);
    // Precision selects the premium lip-animation model. A voice-only dub is
    // handled by the same dubbing path regardless of this otherwise-unused field.
    return blocks * (params.lipsync === true && params.quality === 'precision' ? 2 : 1);
  }
  if (capability === 'LIPSYNC') {
    const blocks = durationBlocks(sourceDurationMs, 30_000, Math.ceil((LIPSYNC_MAX_SEC * 1000) / 30_000));
    return blocks * (params.quality === 'precision' ? 2 : 1);
  }
  return 1;
}

function durationBlocks(durationMs: number | undefined, blockMs: number, maxBlocks: number): number {
  if (!Number.isFinite(durationMs) || !durationMs || durationMs <= 0) return 1;
  return Math.max(1, Math.min(maxBlocks, Math.ceil(durationMs / blockMs)));
}

@Injectable()
export class GenerationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly media: MediaService,
    private readonly queue: QueueService,
    private readonly hooks: GenerationHooks,
  ) {}

  /**
   * Reserve credits and record the intent.
   *
   * Throws InsufficientCreditsError (402) before anything is written, so a
   * customer who cannot afford it never gets a half-created generation. The
   * price is read from CreditCost here and COPIED onto the row — an operator
   * changing the price later must not alter what this customer was charged.
   *
   * IDEMPOTENT BY CLIENT KEY
   * ------------------------
   * The same (workspace, clientKey) returns the row that already exists. The
   * unique index is what enforces it — not a read-then-write, which two
   * concurrent requests would both pass.
   *
   * THE QUEUE COMES LAST, AND CANNOT FAIL THE REQUEST
   * -------------------------------------------------
   * The row and the debit are committed first. Only then is the id put on
   * the queue, and if that fails (Redis down, network blip) the request still
   * succeeds: the worker's dispatcher re-reads QUEUED rows and picks it up.
   */
  async request(req: GenerationRequest): Promise<GenerationResult> {
    // A caller may send back a row's own params ("do it again"), and those carry
    // what the last run wrote for itself — the lyrics, the shot plan, the filmed
    // presenter. Dropped here, so a new request is genuinely new work.
    const asked = withoutPipelineFields((req.params ?? {}) as Record<string, unknown>);
    // Validate before touching money.
    const parsed = parseCapabilityParams(req.capability, asked);
    if (!parsed.ok) throw new ValidationError(parsed.issues);
    const params = parsed.params as Record<string, unknown>;

    // A retry must still work after its source is purged or the daily limit is
    // reached. Never disclose a sibling project's row through a reused key.
    if (req.clientKey) {
      const existing = await this.db.generation.findUnique({ where: { workspaceId_clientKey: { workspaceId: req.workspaceId, clientKey: req.clientKey } } });
      if (existing) {
        this.assertReplayProject(req, existing);
        const wallet = await this.db.wallet.findUnique({ where: { workspaceId: req.workspaceId } });
        return { generation: existing, balance: wallet ? await this.ledger.balance(wallet.id) : 0 };
      }
    }

    // Every storage key named in the params must be a READY object this workspace owns.
    const readyAssets = new Map<string, MediaAsset>();
    for (const [name, value] of Object.entries(params)) {
      const keys = name.endsWith('Key') && typeof value === 'string' ? [value] : name.endsWith('Keys') && Array.isArray(value) ? (value as string[]) : [];
      for (const key of keys) {
        if (!readyAssets.has(key)) readyAssets.set(key, await this.media.requireReady(req.workspaceId, key));
      }
    }
    const sourceDurationMs = await this.billableSourceDuration(req.workspaceId, req.capability, params, readyAssets);
    await this.validateUpscaleSource(req.workspaceId, req.capability, params, readyAssets);

    // Video is where a bug becomes a five-figure invoice. A per-workspace
    // daily count is the cheapest guardrail that fails closed; the
    // provider-level kill switch is ProviderModel.enabled.
    if (VIDEO_CAPABILITIES.has(req.capability)) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const today = await this.db.generation.count({
        where: { workspaceId: req.workspaceId, capability: { in: [...VIDEO_CAPABILITIES] }, kind: { not: 'CHILD' }, createdAt: { gte: since } },
      });
      if (today >= VIDEO_DAILY_LIMIT) {
        logger.warn({ workspaceId: req.workspaceId, today, limit: VIDEO_DAILY_LIMIT }, 'daily video limit reached');
        throw new ValidationError({ capability: `That is ${VIDEO_DAILY_LIMIT} videos in a day — the daily limit. It resets tomorrow.` });
      }
    }

    // Validate the expensive personal-voice branch before generating the
    // base song. The pipeline repeats this ownership check as defence in
    // depth, but discovering it there would spend a music-provider call and
    // then refund the customer for a request we could reject for free here.
    // This follows the client-key replay check: an accepted request remains
    // idempotently readable even if its voice is deactivated afterwards.
    if (req.capability === 'MUSIC' && params.singer === 'me' && params.vocal !== 'instrumental') {
      const voiceId = typeof params.voiceId === 'string' ? params.voiceId : '';
      const voice = voiceId
        ? await this.db.voiceProfile.findUnique({ where: { key: voiceId }, select: { active: true, kind: true, workspaceId: true } })
        : null;
      if (!voice || !voice.active || voice.kind !== 'CLONE' || voice.workspaceId !== req.workspaceId) {
        throw new ValidationError({ voiceId: 'Choose one of this workspace’s active cloned voices.' });
      }
    }

    if (req.capability === 'IMAGE_TO_VIDEO' && params.narration) {
      const voiceId = (params.narration as { voiceId: string }).voiceId;
      const voice = await this.db.voiceProfile.findUnique({ where: { key: voiceId }, select: { active: true, kind: true, workspaceId: true } });
      if (!voice?.active || (voice.kind === 'CLONE' && voice.workspaceId !== req.workspaceId))
        throw new ValidationError({ 'narration.voiceId': 'Choose an active voice available to this workspace.' });
    }

    // Every video is a PARENT, including a one-shot reel. Its provider render
    // is a child and its second pass runs on media.local, which is the only
    // place allowed to normalize duration/aspect with ffmpeg.
    const kind = req.capability === 'IMAGE_TO_VIDEO' || req.capability === 'BATCH' ? 'PARENT' : 'STANDALONE';
    // The code comes only from the capability and the params the server just
    // validated. There is deliberately no caller-supplied escape hatch: a
    // normal request cannot name video.shot (zero credits) or another cheaper
    // row while asking the provider for expensive work.
    const costCode = generationCostCode(req.capability, params);
    const cost = await this.db.creditCost.findUnique({ where: { code: costCode } });
    if (!cost) throw new NotFoundError(`credit cost "${costCode}"`);

    // HOW MANY. Output count and duration both come from validated params and
    // verified media metadata; a browser cannot claim a shorter paid unit.
    const quantity = generationQuantity(req.capability, params, sourceDurationMs);
    const credits = cost.credits * quantity;
    let musicBaseCredits: number | null = null;
    if (costCode === MUSIC_MY_VOICE_COST_CODE) {
      const base = await this.db.creditCost.findUnique({ where: { code: DEFAULT_COST_CODE.MUSIC } });
      if (!base) throw new NotFoundError(`credit cost "${DEFAULT_COST_CODE.MUSIC}"`);
      musicBaseCredits = base.credits * quantity;
    }

    const wallet = await this.db.wallet.findUnique({ where: { workspaceId: req.workspaceId } });
    if (!wallet) throw new NotFoundError('wallet');

    // One transaction: the row and the debit commit together or not at all.
    // A row without its debit is free work; a debit without its row is a
    // charge nobody can explain.
    let generation: Generation;
    try {
      generation = await this.db.$transaction(async (tx) => {
        const row = await tx.generation.create({
          data: {
            workspaceId: req.workspaceId,
            requestedById: req.requestedById,
            capability: req.capability,
            kind,
            parentId: null,
            clientKey: req.clientKey ?? null,
            costCode: cost.code,
            credits,
            stage: 'queued',
            // Capture the fallback price with the debit. CreditCost rows are
            // editable, so looking up the base song price after a provider
            // downgrade could refund using tomorrow's price for today's job.
            input: {
              ...params,
              ...(musicBaseCredits === null ? {} : { _billing: { musicBaseCredits } }),
            } as Prisma.InputJsonObject,
            channel: req.channel ?? 'WEB',
            apiKeyId: req.apiKeyId ?? null,
            projectId: req.projectId ?? null,
            merchantRef: req.merchantRef ?? null,
            ...libraryFields(params),
          },
        });

        await this.ledger.debit(
          {
            walletId: wallet.id,
            amount: credits,
            idempotencyKey: generationDebitKey(row.id),
            referenceId: row.id,
            reason: cost.label,
          },
          tx,
        );

        return row;
      });
    } catch (err) {
      // Two requests raced on the same clientKey: the loser returns the winner's row.
      if (req.clientKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.db.generation.findUnique({ where: { workspaceId_clientKey: { workspaceId: req.workspaceId, clientKey: req.clientKey } } });
        if (winner) {
          this.assertReplayProject(req, winner);
          return { generation: winner, balance: await this.ledger.balance(wallet.id) };
        }
      }
      // A postpaid organization refused by the ledger is at its credit line,
      // not out of credits — say so. Only looked up on the refusal path.
      if (err instanceof InsufficientCreditsError) {
        const account = await this.db.billingAccount.findUnique({ where: { workspaceId: req.workspaceId }, select: { status: true } });
        if (account?.status === 'SUSPENDED')
          throw new CreditLineError('account_suspended', 'This organization has an overdue invoice. Work resumes as soon as it is paid.');
        if (account?.status === 'ACTIVE')
          throw new CreditLineError('credit_limit', 'The credit limit for this period is reached. Pay the open invoice, or ask us to raise the limit.');
      }
      throw err;
    }

    const balance = await this.ledger.balance(wallet.id);
    logger.info(
      {
        generationId: generation.id,
        workspaceId: req.workspaceId,
        capability: req.capability,
        costCode: cost.code,
        credits,
        balance,
      },
      'generation requested: row written, credits held',
    );

    // After the commit, never inside it. See the file comment.
    await this.queue.enqueue(generation.id, req.capability);
    return { generation, balance };
  }

  /**
   * A shot of a plan. Written by the PARENT's pipeline, never by a customer:
   * the parent holds the price, so a child carries zero credits and touches
   * no ledger. It is still a real row — routed, retried, swept and refunded
   * (of nothing) exactly like any other — so a lost shot is a sweep, not a
   * support ticket.
   */
  async createChild(parent: Generation, capability: Capability, params: Record<string, unknown>, index: number): Promise<Generation> {
    const clientKey = `${parent.id}:shot:${index}`;
    // A parent can die after dispatching only some of its shots. Its next
    // attempt must reuse those exact work units: inserting them again either
    // violates the client-key constraint forever or, without that constraint,
    // pays a vendor twice for the same frame. The parent id and shot index are
    // the durable idempotency key.
    const child = await this.db.generation.upsert({
      where: { workspaceId_clientKey: { workspaceId: parent.workspaceId, clientKey } },
      create: {
        workspaceId: parent.workspaceId,
        requestedById: parent.requestedById,
        capability,
        kind: 'CHILD',
        parentId: parent.id,
        clientKey,
        costCode: 'video.shot',
        credits: 0,
        stage: 'queued',
        input: params as Prisma.InputJsonObject,
        channel: parent.channel,
        apiKeyId: parent.apiKeyId,
        projectId: parent.projectId,
        merchantRef: parent.merchantRef,
      },
      update: {},
    });
    if (child.parentId !== parent.id || child.kind !== 'CHILD' || child.capability !== capability || child.credits !== 0) {
      throw new ConflictError(`Shot ${index + 1} belongs to a different generation request.`);
    }
    // Re-enqueueing QUEUED work is safe (the queue job id is the generation
    // id) and repairs a crash between the database commit and queue publish.
    // A RUNNING or terminal child already has an owner or an answer.
    if (child.status === 'QUEUED') await this.queue.enqueue(child.id, capability);
    return child;
  }

  /**
   * A parent that dispatched its shots and stepped aside. The row stays
   * RUNNING with stage 'waiting'; the children's heartbeats keep it alive;
   * the last child to finish puts it back on the queue to assemble.
   */
  async wait(id: string): Promise<void> {
    await this.db.generation.updateMany({ where: { id, status: 'RUNNING' }, data: { stage: 'waiting', progress: 20, heartbeatAt: new Date() } });
  }

  /**
   * Claim a waiting parent for its second run. Conditional on stage
   * 'waiting', so two children finishing at once cannot both assemble it.
   */
  async resume(id: string): Promise<Generation | null> {
    const { count } = await this.db.generation.updateMany({
      where: { id, status: 'RUNNING', kind: 'PARENT', stage: 'waiting', attempts: { lt: MAX_ATTEMPTS } },
      // Planning is attempt one; every assembly claim is another attempt. If
      // ffmpeg or its worker repeatedly disappears, the normal retry ceiling
      // eventually refunds the parent instead of looping forever.
      data: { stage: 'composing', heartbeatAt: new Date(), attempts: { increment: 1 } },
    });
    if (count === 0) return null;
    return this.db.generation.findUnique({ where: { id } });
  }

  /** Put a failed parent assembly back into the one state resume() may claim. */
  async retryParentAssembly(id: string, reason: string): Promise<boolean> {
    const { count } = await this.db.generation.updateMany({
      where: { id, status: 'RUNNING', kind: 'PARENT', stage: 'composing', attempts: { lt: MAX_ATTEMPTS } },
      data: { stage: 'waiting', heartbeatAt: new Date(), failureReason: reason.slice(0, 2000) },
    });
    return count > 0;
  }

  /** A child checked in: its parent is alive too. */
  async touchParent(childId: string): Promise<void> {
    const child = await this.db.generation.findUnique({ where: { id: childId }, select: { parentId: true } });
    if (child?.parentId) await this.db.generation.updateMany({ where: { id: child.parentId, status: 'RUNNING' }, data: { heartbeatAt: new Date() } });
  }

  /**
   * "Shots are rendering" for six minutes tells a seller nothing. This counts
   * the parent's children so the card can say which shot it is on; the caller
   * publishes it, because the wording belongs to the worker.
   */
  async shotProgress(parentId: string): Promise<{ done: number; running: number; total: number; progress: number; detail: string } | null> {
    const children = await this.db.generation.findMany({ where: { parentId }, select: { status: true } });
    if (children.length === 0) return null;
    const done = children.filter((c) => c.status === 'SUCCEEDED').length;
    const running = children.filter((c) => c.status === 'RUNNING').length;
    const detail =
      done >= children.length
        ? 'putting the ad together'
        : `shot ${Math.min(done + 1, children.length)} of ${children.length}${running > 1 ? ` · ${running} rendering at once` : ''}`;
    // 20 % for the plan, 50 % shared across the shots, the rest for stitching.
    const progress = Math.round(20 + (done / children.length) * 50);
    await this.db.generation.updateMany({ where: { id: parentId, status: 'RUNNING' }, data: { progress, heartbeatAt: new Date() } });
    return { done, running, total: children.length, progress, detail };
  }

  private assertReplayProject(req: GenerationRequest, existing: Generation): void {
    if (req.channel === 'API' && (existing.projectId !== req.projectId || existing.channel !== 'API' || existing.kind === 'CHILD' || existing.deletedAt)) {
      throw new ConflictError('That clientKey is already in use outside this project. Use a workspace-unique key.');
    }
  }

  /** Estimate the current charge without creating a generation or debiting credits. */
  async quote(
    workspaceId: string,
    capability: Capability,
    params: Record<string, unknown> = {},
  ): Promise<{ costCode: string; credits: number; label: string; balance: number; balanceAfter: number; expectedMs: number }> {
    const code = generationCostCode(capability, params);
    const cost = await this.db.creditCost.findUnique({ where: { code } });
    if (!cost) throw new NotFoundError(`credit cost "${code}"`);
    /** Counts come from the same capability fields and media metadata the eventual request uses. */
    const sourceDurationMs = await this.billableSourceDuration(workspaceId, capability, params);
    await this.validateUpscaleSource(workspaceId, capability, params);
    const quantity = generationQuantity(capability, params, sourceDurationMs);
    const each = cost.credits;
    const total = each * Math.max(1, Math.min(quantity, BATCH_MAX));
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId } });
    if (!wallet) throw new NotFoundError('wallet');
    const balance = await this.ledger.balance(wallet.id);
    return {
      costCode: cost.code,
      credits: total,
      label: quantity > 1 ? `${cost.label} × ${quantity}` : cost.label,
      balance,
      balanceAfter: balance - total,
      expectedMs: EXPECTED_MS[capability] * (capability === 'BATCH' ? Math.max(1, quantity) : 1),
    };
  }

  /**
   * Dubbing vendors bill by source length. Use the duration verified from the
   * stored bytes, and reject an over-limit input before reserving credits.
   */
  private async validateUpscaleSource(
    workspaceId: string,
    capability: Capability,
    params: Record<string, unknown>,
    readyAssets?: Map<string, MediaAsset>,
  ): Promise<void> {
    if (capability === 'BATCH' && params.of === 'UPSCALE' && Array.isArray(params.sourceKeys)) {
      for (const sourceKey of params.sourceKeys)
        await this.validateUpscaleSource(workspaceId, 'UPSCALE', { ...((params.params as Record<string, unknown>) ?? {}), sourceKey }, readyAssets);
      return;
    }
    if (capability !== 'UPSCALE' || typeof params.sourceKey !== 'string') return;
    const asset = readyAssets?.get(params.sourceKey) ?? (await this.media.requireReady(workspaceId, params.sourceKey));
    let width = asset.width;
    let height = asset.height;
    if (!width || !height) {
      try {
        const meta = await sharp(await this.media.getBytes(asset.key), { limitInputPixels: 40_000_000 }).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch {
        throw new ValidationError({ sourceKey: 'Could not read this image’s dimensions. Upload a JPEG, PNG or WebP image again.' });
      }
    }
    validateUpscaleSize(width ?? 0, height ?? 0, Number(params.factor ?? 2));
  }

  private async billableSourceDuration(
    workspaceId: string,
    capability: Capability,
    params: Record<string, unknown>,
    readyAssets?: ReadonlyMap<string, MediaAsset>,
  ): Promise<number | undefined> {
    if (capability !== 'DUB' && capability !== 'LIPSYNC') return undefined;
    const key = typeof params.sourceKey === 'string' ? params.sourceKey : '';
    // Quotes are also requested while a form is incomplete. The final request
    // schema requires a source, so one base unit is only a provisional quote.
    if (!key) return undefined;
    const asset = readyAssets?.get(key) ?? (await this.media.requireReady(workspaceId, key));
    if (!asset.mime?.startsWith('video/')) throw new ValidationError({ sourceKey: 'Choose a video file.' });
    const measured = await this.media.ensureDuration(asset);
    const durationMs = measured.durationMs;
    if (!durationMs || durationMs <= 0) throw new ValidationError({ sourceKey: 'That video has no measurable duration.' });
    const maxSec = capability === 'DUB' ? DUB_MAX_SEC : LIPSYNC_MAX_SEC;
    if (durationMs > maxSec * 1000) {
      throw new ValidationError({ sourceKey: `That video is ${Math.ceil(durationMs / 1000)} seconds long; the limit is ${maxSec / 60} minutes.` });
    }
    return durationMs;
  }

  /**
   * The seller edited a piece of generated copy. The stored text output is
   * updated at that path so the library and a later re-run see the words
   * they actually posted. Only text outputs, only known fields, only on a
   * finished row — a running generation would overwrite it anyway.
   */
  async editText(workspaceId: string, id: string, field: string, value: string): Promise<Generation> {
    const spec = COPY_FIELDS[field];
    if (!spec) throw new ValidationError({ field: `Unknown field "${field}"` });
    if (value.length > spec.max) throw new ValidationError({ value: `Keep ${spec.label} under ${spec.max} characters.` });
    const row = await this.db.generation.findUnique({ where: { id } });
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundError('generation');
    if (row.status !== 'SUCCEEDED') throw new ConflictError('That generation has not finished.');
    const outputs = (row.outputs as unknown as GenerationOutput[] | null) ?? [];
    const text = outputs.find((o) => o.role === 'text');
    if (!text || typeof text.text !== 'object' || text.text === null) throw new NotFoundError('text output');
    const doc = structuredClone(text.text) as Record<string, unknown>;
    const path = field.split('.');
    let cur: Record<string, unknown> = doc;
    for (const part of path.slice(0, -1)) {
      if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
      cur = cur[part] as Record<string, unknown>;
    }
    cur[path[path.length - 1]!] = value;
    const next = outputs.map((o) => (o === text ? { ...o, text: doc } : o));
    logger.info({ generationId: id, workspaceId, field }, 'copy edited by the seller');
    return this.db.generation.update({ where: { id }, data: { outputs: next as unknown as Prisma.InputJsonArray } });
  }

  /** One generation, only if the workspace owns it. */
  async get(workspaceId: string, id: string): Promise<GenerationView> {
    const row = await this.db.generation.findUnique({ where: { id }, include: { children: { orderBy: { createdAt: 'asc' } } } });
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundError('generation');
    return { generation: forCustomer(row), message: customerMessage(row) };
  }

  /**
   * A worker has picked it up.
   *
   * Conditional on the row still being QUEUED, so two workers racing the same
   * id cannot both start it — the loser gets no row back and drops the job.
   * Returns null in that case rather than throwing: losing the race is normal
   * operation, not an error.
   */
  async start(id: string, providerKey?: string): Promise<Generation | null> {
    const { count } = await this.db.generation.updateMany({
      where: { id, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        heartbeatAt: new Date(),
        attempts: { increment: 1 },
        ...(providerKey ? { providerKey } : {}),
      },
    });
    if (count === 0) return null;
    return this.db.generation.findUnique({ where: { id } });
  }

  /**
   * Still working.
   *
   * The worker calls this while it waits on the provider. Without it the
   * sweeper cannot tell a long video generation from a dead worker, and would
   * have to choose between killing honest work and never reclaiming anything.
   */
  async heartbeat(id: string): Promise<void> {
    await this.db.generation.updateMany({
      where: { id, status: 'RUNNING' },
      data: { heartbeatAt: new Date() },
    });
  }

  /**
   * Put a RUNNING row back on the shelf for another attempt. Only the worker
   * calls this, and only for failures whose kind says retrying could help.
   * The attempt count already went up in start(); it is never reset.
   */
  async requeue(id: string, reason: string, guard: Prisma.GenerationWhereInput = {}): Promise<boolean> {
    const { count } = await this.db.generation.updateMany({
      where: { id, status: 'RUNNING', AND: guard },
      data: { status: 'QUEUED', heartbeatAt: null, stage: 'queued', progress: 0, failureReason: reason.slice(0, 2000) },
    });
    return count > 0;
  }

  /**
   * Give back the share of a batch that did not work.
   *
   * A folder of forty where three failed is not a failed generation — the
   * merchant has thirty-seven pictures. Refusing the lot would throw away
   * good work; keeping the whole fee would charge for pictures that do not
   * exist. So the parent succeeds and hands back exactly the failed share,
   * under its own idempotency key so a replayed assembly cannot pay twice.
   */
  async refundShare(row: Generation, credits: number, reason: string): Promise<void> {
    const amount = Math.min(Math.max(Math.round(credits), 0), row.credits);
    if (amount === 0) return;
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId: row.workspaceId } });
    if (!wallet) return;
    await this.ledger.refund({
      walletId: wallet.id,
      amount,
      idempotencyKey: `${generationDebitKey(row.id)}:share`,
      referenceId: row.id,
      reason,
    });
    logger.info({ generationId: row.id, credits: amount, of: row.credits, reason }, 'refunded the share of a batch that failed');
  }

  /** Outputs are stored. The debit stands, except a captured premium for an explicitly downgraded result. */
  async succeed(id: string, outcome: GenerationOutcome): Promise<Generation> {
    const done = await this.db.$transaction(async (tx) => {
      const row = await this.terminalCandidate(tx, id);
      // Invoice closing uses this same wallet row as its serialization point.
      // If completion wins, this generation is visible in that invoice; if
      // closing wins, finishedAt is stamped afterwards and the next period
      // picks it up. A pre-cutoff transaction can therefore never disappear
      // between period snapshots.
      const wallets = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "wallets" WHERE "workspaceId" = CAST(${row.workspaceId} AS uuid) FOR UPDATE
      `;
      const walletId = wallets[0]?.id;
      if (!walletId) throw new NotFoundError('wallet');
      const finishedAt = new Date();
      // The copy that came back is the most searchable thing about a text generation.
      const copyText = (outcome.outputs ?? [])
        .filter((o) => o.role === 'text' && o.text !== undefined)
        .map((o) => flattenText(o.text))
        .join(' ')
        .trim();
      const searchText = [row.searchText, copyText].filter(Boolean).join(' ').slice(0, 8000) || undefined;
      const downgrade = musicVoiceDowngradeCredits(row, outcome.outputs);
      const { count } = await tx.generation.updateMany({
        where: { id: row.id, status: { notIn: [...TERMINAL_STATUSES] } },
        data: {
          status: 'SUCCEEDED',
          finishedAt,
          stage: 'done',
          progress: 100,
          ...(downgrade > 0 ? { credits: row.credits - downgrade } : {}),
          ...(searchText ? { searchText } : {}),
          outputs: (outcome.outputs ?? []) as unknown as Prisma.InputJsonArray,
          ...(outcome.providerKey ? { providerKey: outcome.providerKey } : {}),
          ...(outcome.providerJobId ? { providerJobId: outcome.providerJobId } : {}),
          ...(outcome.providerCostMinor !== undefined ? { providerCostMinor: outcome.providerCostMinor } : {}),
        },
      });
      if (count === 0) await this.throwTerminalConflict(tx, id);
      // A waiting parent still needs its presenter clip. This runs only in
      // the terminal transaction, after assembly has stored the final output.
      await this.media.retireGenerationWork({ workspaceId: row.workspaceId, generationId: row.id, createdAt: row.createdAt }, tx);
      if (downgrade > 0) {
        await this.ledger.refund(
          {
            walletId,
            amount: downgrade,
            idempotencyKey: `${generationDebitKey(row.id)}:music-voice-downgrade`,
            referenceId: row.id,
            reason: 'Personal voice was not applied; charged the base song price only',
          },
          tx,
        );
      }
      return tx.generation.findUniqueOrThrow({ where: { id } });
    });
    await this.purgeRetiredWork(done);
    this.hooks.finished(done);
    return done;
  }

  /** It ended badly. Give the credits back. */
  async fail(id: string, outcome: GenerationOutcome, guard: Prisma.GenerationWhereInput = {}): Promise<Generation> {
    const done = await this.db.$transaction(async (tx) => {
      const row = await this.terminalCandidate(tx, id);
      const finishedAt = new Date();
      const [ownAttempts, childSpend] = await Promise.all([
        tx.providerAttempt.aggregate({ where: { generationId: row.id, status: 'SUCCEEDED' }, _sum: { costMinor: true } }),
        row.kind === 'PARENT'
          ? tx.generation.aggregate({ where: { parentId: row.id }, _sum: { providerCostMinor: true } })
          : Promise.resolve({ _sum: { providerCostMinor: null } }),
      ]);
      // A sweeper has no in-memory runner totals, and a process may disappear
      // after provider acceptance but before it can copy spend onto Generation.
      // The journal is the durable source of truth. `max` accepts a runner's
      // legacy/un-journaled total without adding the same operation twice.
      const journalledCost = (ownAttempts._sum.costMinor ?? 0) + (childSpend._sum.providerCostMinor ?? 0);
      const providerCostMinor = Math.max(row.providerCostMinor ?? 0, outcome.providerCostMinor ?? 0, journalledCost);
      const { count } = await tx.generation.updateMany({
        where: { id: row.id, status: { notIn: [...TERMINAL_STATUSES] }, AND: guard },
        data: {
          status: 'FAILED',
          finishedAt,
          stage: 'failed',
          failureReason: outcome.failureReason ?? null,
          failureKind: outcome.failureKind ?? null,
          ...(outcome.providerKey ? { providerKey: outcome.providerKey } : {}),
          ...(outcome.providerJobId ? { providerJobId: outcome.providerJobId } : {}),
          ...(providerCostMinor > 0 || outcome.providerCostMinor !== undefined ? { providerCostMinor } : {}),
        },
      });
      if (count === 0) await this.throwTerminalConflict(tx, id);
      await this.media.retireGenerationWork({ workspaceId: row.workspaceId, generationId: row.id, createdAt: row.createdAt }, tx);
      if (row.credits > 0) await this.refund(row, outcome.failureReason ?? 'generation failed', tx);
      return tx.generation.findUniqueOrThrow({ where: { id } });
    });
    await this.purgeRetiredWork(done);
    this.hooks.finished(done);
    return done;
  }

  /**
   * The customer changed their mind.
   *
   * Only while QUEUED. Once a provider has been called the money is spent on
   * our side whatever the customer wants, and pretending otherwise would mean
   * refunding work we have already paid for.
   */
  async cancel(id: string, workspaceId?: string): Promise<Generation> {
    const done = await this.db.$transaction(async (tx) => {
      const row = await tx.generation.findUnique({ where: { id } });
      if (!row || (workspaceId && row.workspaceId !== workspaceId)) throw new NotFoundError('generation');
      if (row.status !== 'QUEUED') throw new ConflictError('That generation has already started and cannot be cancelled.');
      const { count } = await tx.generation.updateMany({
        where: { id, status: 'QUEUED', ...(workspaceId ? { workspaceId } : {}) },
        data: { status: 'CANCELLED', finishedAt: new Date(), stage: 'failed' },
      });
      if (count === 0) throw new ConflictError('That generation has already started and cannot be cancelled.');
      await this.media.retireGenerationWork({ workspaceId: row.workspaceId, generationId: row.id, createdAt: row.createdAt }, tx);
      if (row.credits > 0) await this.refund(row, 'cancelled before it started', tx);
      return tx.generation.findUniqueOrThrow({ where: { id } });
    });
    await this.purgeRetiredWork(done);
    logger.info({ generationId: id, workspaceId: done.workspaceId, credits: done.credits }, 'generation cancelled; credits returned');
    return done;
  }

  /**
   * Rows that are QUEUED but were never picked up — because the enqueue
   * failed, Redis lost the job, or the worker was down. The dispatcher calls
   * this on a timer and puts each one back on its queue; the job id is the
   * row id, so a row that WAS enqueued and is simply waiting is not doubled.
   */
  async redispatchOrphans(now = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - DISPATCH_AFTER_MS);
    const rows = await this.db.generation.findMany({
      where: { status: 'QUEUED', createdAt: { lt: cutoff } },
      select: { id: true, capability: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const dispatched: string[] = [];
    for (const row of rows) {
      const result = await this.queue.enqueue(row.id, row.capability);
      if (result.queued) dispatched.push(row.id);
    }
    if (dispatched.length) {
      logger.warn(
        { count: dispatched.length, oldest: rows[0]?.createdAt, dispatched: dispatched.slice(0, 20) },
        'dispatcher re-queued generations that had no job behind them',
      );
    }
    return dispatched;
  }

  /**
   * Reclaim generations nobody is working on any more.
   *
   * This is what makes a lost job survivable. Three cases, treated
   * differently because they mean different things:
   *
   *   - RUNNING with a quiet heartbeat: the worker that had it died mid-job
   *     (a deploy, a crash, an out-of-memory). The work is not wrong, just
   *     interrupted — so it goes back on the queue for another attempt
   *     while attempts remain, and only then is failed and refunded.
   *   - RUNNING, a parent in 'waiting': its shots are the ones alive, and
   *     they keep its heartbeat; while any shot is still queued or running
   *     the parent is left alone however quiet it is.
   *   - QUEUED for a very long time: nothing picked it up in an hour and a
   *     half. The dispatcher re-queues orphans far sooner than this, so by
   *     now the wait itself is the failure; refund.
   *
   * Returns the ids it reclaimed (failed or requeued), so the caller can log
   * and alert on a number that should normally be zero.
   */
  async sweepStale(now = new Date()): Promise<string[]> {
    const runningCutoff = new Date(now.getTime() - STALE_AFTER_MS);
    const queuedCutoff = new Date(now.getTime() - QUEUED_STALE_AFTER_MS);
    const stale = await this.db.generation.findMany({
      where: {
        OR: [
          {
            status: 'RUNNING',
            OR: [{ heartbeatAt: { lt: runningCutoff } }, { heartbeatAt: null, createdAt: { lt: runningCutoff } }],
            NOT: { kind: 'PARENT', stage: 'waiting', children: { some: { status: { in: ['QUEUED', 'RUNNING'] } } } },
          },
          { status: 'QUEUED', createdAt: { lt: queuedCutoff } },
        ],
      },
      select: { id: true, status: true, kind: true, capability: true, attempts: true, heartbeatAt: true, createdAt: true, stage: true, input: true },
      take: 100, // bounded: a backlog is drained over several runs, not one long lock
    });

    const reclaimed: string[] = [];
    for (const row of stale) {
      try {
        const quietMin = Math.round((now.getTime() - (row.heartbeatAt ?? row.createdAt).getTime()) / 60_000);
        // The heartbeat value we selected is an optimistic claim token. If a
        // supposedly dead worker checks in before this write, the predicate
        // no longer matches and the sweeper leaves its live job alone.
        const staleGuard: Prisma.GenerationWhereInput =
          row.status === 'RUNNING'
            ? row.heartbeatAt
              ? { heartbeatAt: row.heartbeatAt }
              : { heartbeatAt: null, createdAt: { lt: runningCutoff } }
            : { status: 'QUEUED', createdAt: { lt: queuedCutoff } };
        if (row.status === 'RUNNING' && row.attempts < MAX_ATTEMPTS) {
          const reason = `the worker stopped mid-job (no heartbeat for ${quietMin} min — usually a restart); trying again, attempt ${row.attempts + 1} of ${MAX_ATTEMPTS}`;
          let queuedCapability: Capability = row.capability;
          let claimed = false;
          if (row.kind === 'PARENT') {
            const [children, activeChildren] = await Promise.all([
              this.db.generation.count({ where: { parentId: row.id } }),
              this.db.generation.count({ where: { parentId: row.id, status: { in: ['QUEUED', 'RUNNING'] } } }),
            ]);
            const savedPlan = shotPlanFromInput(row.input);
            const input = row.input as { shots?: number; sourceKeys?: unknown } | null;
            const singleReel = row.capability === 'IMAGE_TO_VIDEO' && Number(input?.shots ?? 1) === 1;
            const batchSize = row.capability === 'BATCH' && Array.isArray(input?.sourceKeys) ? input.sourceKeys.length : null;
            const expectedChildren = batchSize ?? savedPlan?.shots.length ?? (singleReel ? 1 : null);
            const readyToAssemble = expectedChildren !== null && children === expectedChildren && activeChildren === 0;
            if (readyToAssemble) {
              // Keep the row RUNNING and put it back into the one legitimate
              // resume state. The media queue then calls resume(), which
              // atomically claims and counts this assembly attempt.
              const { count } = await this.db.generation.updateMany({
                where: { id: row.id, status: 'RUNNING', AND: staleGuard },
                data: { stage: 'waiting', heartbeatAt: now, failureReason: reason.slice(0, 2000) },
              });
              claimed = count > 0;
              queuedCapability = parentResumeCapability(row.capability);
            } else {
              // Planning or dispatch stopped part-way through. createChild()
              // is idempotent, so the next parent attempt reuses every shot
              // already committed and fills in only the missing indices.
              claimed = await this.requeue(row.id, reason, staleGuard);
            }
          } else {
            claimed = await this.requeue(row.id, reason, staleGuard);
          }
          if (!claimed) continue;
          const r = await this.queue.enqueue(row.id, queuedCapability);
          logger.warn(
            { generationId: row.id, capability: row.capability, queuedCapability, attempts: row.attempts, queued: r.queued },
            'sweeper requeued an interrupted generation',
          );
        } else if (row.status === 'RUNNING') {
          await this.fail(
            row.id,
            {
              failureReason:
                row.kind === 'PARENT'
                  ? `the ad worker stopped reporting ${row.attempts} times while planning or assembling (last heartbeat ${quietMin} min ago). Credits refunded — try again.`
                  : `the worker stopped mid-job ${row.attempts} times (no heartbeat for ${quietMin} min each time). Credits refunded.`,
            },
            staleGuard,
          );
        } else {
          await this.fail(
            row.id,
            {
              failureReason: `waited ${quietMin} min and no worker picked it up. Credits refunded — check the worker is running.`,
            },
            staleGuard,
          );
        }
        reclaimed.push(row.id);
      } catch (err) {
        // One poisoned row must not stop the others being refunded.
        logger.error({ err, generationId: row.id }, 'sweeper could not reclaim generation');
      }
    }
    if (reclaimed.length) logger.warn({ count: reclaimed.length, reclaimed }, 'generations reclaimed by the sweeper');
    return reclaimed;
  }

  /**
   * Parents whose shots have all finished but that nobody woke — the wake-up
   * enqueue failed, or the worker that ran the last shot died between the
   * update and the enqueue. The dispatcher calls this on its timer. The row
   * remains IMAGE_TO_VIDEO, but that resume job belongs on media.local because
   * its next step is ffmpeg assembly. A BATCH resume stays on media.fast because
   * it only gathers already-stored child outputs. When `servedCapabilities` is
   * supplied, only parents whose resume work belongs to one of those queue
   * capabilities are returned, preserving the service boundary in direct mode.
   */
  async wakeReadyParents(servedCapabilities?: readonly Capability[]): Promise<string[]> {
    // Filter before `take`: if fifty ready ads are ahead of a batch, the fast
    // worker must still be able to see that batch rather than filtering an
    // already-truncated page down to nothing forever (and vice versa).
    const parentCapabilities = servedCapabilities
      ? CAPABILITIES.filter((capability) => servedCapabilities.includes(parentResumeCapability(capability)))
      : undefined;
    const parents = await this.db.generation.findMany({
      where: {
        status: 'RUNNING',
        kind: 'PARENT',
        stage: 'waiting',
        children: { none: { status: { in: ['QUEUED', 'RUNNING'] } } },
        ...(parentCapabilities ? { capability: { in: [...parentCapabilities] } } : {}),
      },
      select: { id: true, capability: true },
      take: 50,
    });
    const ready = parents.filter((parent) => {
      const resumeCapability = parentResumeCapability(parent.capability);
      return !servedCapabilities || servedCapabilities.includes(resumeCapability);
    });
    const woken: string[] = [];
    for (const p of ready) {
      const r = await this.queue.enqueue(p.id, parentResumeCapability(p.capability));
      if (r.queued) woken.push(p.id);
    }
    if (woken.length) logger.warn({ count: woken.length, woken }, 'dispatcher woke parents whose shots had all finished');
    return ready.map((p) => p.id);
  }

  /** The customer's history, newest first. Children ride inside their parent, not beside it. */
  async history(workspaceId: string, take = 50, cursor?: string): Promise<Generation[]> {
    const rows = await this.db.generation.findMany({
      where: { workspaceId, kind: { not: 'CHILD' }, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    return rows.map(forCustomer);
  }

  /**
   * Read the row needed to build a terminal update.
   *
   * This early check gives a useful error, but it is not the race guard: the
   * subsequent update still includes a non-terminal status predicate in the
   * same transaction. A provider answer and a sweeper can both read RUNNING;
   * only one of those conditional updates can claim it.
   */
  private async terminalCandidate(tx: Prisma.TransactionClient, id: string): Promise<Generation> {
    const row = await tx.generation.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('generation');
    if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
      throw new ConflictError(`That generation already ${row.status.toLowerCase()}.`);
    }
    return row;
  }

  /** Resolve the winner after a conditional update lost a terminal race. */
  private async throwTerminalConflict(tx: Prisma.TransactionClient, id: string): Promise<never> {
    const row = await tx.generation.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('generation');
    throw new ConflictError(`That generation already ${row.status.toLowerCase()}.`);
  }

  /**
   * Terminal truth and money must never roll back because object storage is
   * temporarily unavailable. Work rows were retired in the transaction; this
   * is the fast path, while retention is the durable retry path.
   */
  private async purgeRetiredWork(row: Pick<Generation, 'id' | 'workspaceId' | 'createdAt'>): Promise<void> {
    try {
      const objects = await this.media.purgeGenerationWork({
        workspaceId: row.workspaceId,
        generationId: row.id,
        createdAt: row.createdAt,
      });
      if (objects > 0) logger.info({ generationId: row.id, workspaceId: row.workspaceId, objects }, 'generation work objects purged');
    } catch (err) {
      logger.warn({ err, generationId: row.id, workspaceId: row.workspaceId }, 'generation work cleanup deferred to retention');
    }
  }

  /** Give back exactly what was taken, keyed so it can only happen once. */
  private async refund(row: Generation, reason: string, tx: Prisma.TransactionClient | PrismaClient = this.db): Promise<void> {
    const wallet = await tx.wallet.findUnique({ where: { workspaceId: row.workspaceId } });
    if (!wallet) throw new NotFoundError('wallet');
    await this.ledger.refund(
      {
        walletId: wallet.id,
        amount: row.credits,
        idempotencyKey: generationDebitKey(row.id),
        referenceId: row.id,
        reason,
      },
      tx,
    );
  }
}

/** Exact captured premium to return when a successful song stayed in the model voice. */
export function musicVoiceDowngradeCredits(row: Pick<Generation, 'capability' | 'costCode' | 'credits' | 'input'>, outputs?: GenerationOutput[]): number {
  if (row.capability !== 'MUSIC' || row.costCode !== MUSIC_MY_VOICE_COST_CODE) return 0;
  const downgraded = (outputs ?? []).some((output) => {
    if (output.role !== 'text' || !output.text || typeof output.text !== 'object' || Array.isArray(output.text)) return false;
    const myVoice = (output.text as Record<string, unknown>).myVoice;
    return Boolean(myVoice && typeof myVoice === 'object' && !Array.isArray(myVoice) && (myVoice as Record<string, unknown>).applied === false);
  });
  if (!downgraded || !row.input || typeof row.input !== 'object' || Array.isArray(row.input)) return 0;
  const billing = (row.input as Record<string, unknown>)._billing;
  if (!billing || typeof billing !== 'object' || Array.isArray(billing)) return 0;
  const baseCredits = Number((billing as Record<string, unknown>).musicBaseCredits);
  if (!Number.isInteger(baseCredits) || baseCredits < 0) return 0;
  return Math.max(0, row.credits - baseCredits);
}

/** A parent plan is usable for recovery only after its full schema was committed. */
function shotPlanFromInput(input: Prisma.JsonValue): ShotPlan | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const parsed = shotPlanSchema.safeParse((input as Record<string, unknown>).plan);
  return parsed.success ? parsed.data : null;
}

/** The sentence a customer reads on a failed row. Never the vendor's words. */
export function customerMessage(row: Generation): string | undefined {
  if (row.status !== 'FAILED') return undefined;
  const kind = row.failureKind as ProviderErrorKind | 'TIMEOUT' | 'INTERNAL' | null;
  if (kind && kind in CUSTOMER_MESSAGE) return CUSTOMER_MESSAGE[kind as ProviderErrorKind];
  if (kind === 'TIMEOUT') return 'That took too long and was stopped. Your credits are back — try again.';
  return 'Something went wrong on our side. Your credits are back and we have been notified.';
}

// ---------------------------------------------------------------- library

/** Title, product key and searchable text, derived from the params at request time. */
export function libraryFields(params: Record<string, unknown>): { title: string | null; productKey: string | null; searchText: string | null } {
  const str = (k: string) => (typeof params[k] === 'string' ? (params[k] as string).trim() : '');
  const name = str('productName');
  const prompt = str('prompt');
  const target = str('targetLanguage');
  const targetName = target ? (dubLanguage(target)?.name ?? target) : '';
  const script = str('script');
  const title =
    name ||
    (prompt ? prompt.split(/\s+/).slice(0, 8).join(' ') : '') ||
    (targetName ? `Dubbed into ${targetName}` : '') ||
    (script ? script.split(/\s+/).slice(0, 8).join(' ') : '') ||
    null;
  const productKey = str('productKey') || (name ? slug(name) : '') || null;
  const parts = [
    name,
    prompt,
    str('details'),
    str('price'),
    str('caption'),
    str('scene'),
    str('instruction'),
    str('field'),
    str('format'),
    str('language'),
    targetName,
    script,
    str('brief'),
    str('title'),
    str('genre'),
  ].filter(Boolean);
  return { title, productKey, searchText: parts.length ? parts.join(' ').slice(0, 4000) : null };
}

export function slug(v: string): string {
  return v
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/** Copy outputs are nested objects; the words are what matter. */
function flattenText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(flattenText).join(' ');
  if (v && typeof v === 'object')
    return Object.values(v as Record<string, unknown>)
      .map(flattenText)
      .join(' ');
  return '';
}

/**
 * A row as the customer may see it.
 *
 * Two things are ours and not theirs.
 *
 * A vaulted song's key stays behind until it is unlocked — that one is the
 * business model. The other is WHO MADE IT AND WHAT WE PAID THEM: `providerKey`, the vendor's job
 * id, what the call cost us, and the vendor's own failure text. None of it is rendered anywhere in
 * the studio, but it rode along in the JSON, which is the same leak one layer
 * down — a merchant opening the network tab learns which supplier had the GPU
 * this morning, and next month, after an operator reroutes the capability,
 * learns something different and equally none of their business.
 *
 * `failureKind` stays: it is a category of ours (LOW_QUALITY, TIMEOUT), it
 * chooses the sentence the customer reads, and it names nobody.
 */
export function forCustomer<T extends Generation>(row: T): T {
  const outputs = row.outputs as Array<{ key: string; locked?: boolean }> | null;
  const redacted = {
    ...row,
    providerKey: null,
    providerJobId: null,
    // What we paid the vendor. That is the margin, in the customer's own
    // network tab, on every generation they have ever made.
    providerCostMinor: null,
    // The vendor's own words, often with their name in them. The customer gets
    // customerMessage() instead, which is ours and says what to do next.
    failureReason: null,
    children: Array.isArray((row as { children?: unknown }).children)
      ? ((row as unknown as { children: Generation[] }).children.map(forCustomer) as unknown)
      : (row as { children?: unknown }).children,
  } as T;
  if (!outputs?.some((o) => o.locked)) return redacted;
  return { ...redacted, outputs: redactLocked(outputs) as unknown as Prisma.JsonValue };
}
