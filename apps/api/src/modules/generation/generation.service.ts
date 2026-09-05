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
import { Prisma, PrismaClient, type Generation } from '@prisma/client';
import { COPY_FIELDS, CUSTOMER_MESSAGE, DEFAULT_COST_CODE, DUB_LIPSYNC_COST_CODE, dubLanguage, generationDebitKey, parseCapabilityParams, redactLocked, type Capability, type GenerationOutput, type ProviderErrorKind } from '@anystudio/shared';
import { EXPECTED_MS } from '../provider/adapters/base';
import { GenerationHooks } from './generation.hooks';
import { LedgerService } from '../ledger/ledger.service';
import { MediaService } from '../media/media.service';
import { QueueService } from '../queue/queue.service';
import { ConflictError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import {
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
    // Validate before touching money.
    const parsed = parseCapabilityParams(req.capability, req.params);
    if (!parsed.ok) throw new ValidationError(parsed.issues);
    const params = parsed.params as Record<string, unknown>;

    // Every storage key named in the params must be a READY object this workspace owns.
    for (const [name, value] of Object.entries(params)) {
      const keys = name.endsWith('Key') && typeof value === 'string' ? [value] : name.endsWith('Keys') && Array.isArray(value) ? (value as string[]) : [];
      for (const key of keys) await this.media.requireReady(req.workspaceId, key);
    }

    // Video is where a bug becomes a five-figure invoice. A per-workspace
    // daily count is the cheapest guardrail that fails closed; the
    // provider-level kill switch is ProviderModel.enabled.
    if (VIDEO_CAPABILITIES.has(req.capability) && req.kind !== 'CHILD') {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const today = await this.db.generation.count({ where: { workspaceId: req.workspaceId, capability: { in: [...VIDEO_CAPABILITIES] }, kind: { not: 'CHILD' }, createdAt: { gte: since } } });
      if (today >= VIDEO_DAILY_LIMIT) {
        logger.warn({ workspaceId: req.workspaceId, today, limit: VIDEO_DAILY_LIMIT }, 'daily video limit reached');
        throw new ValidationError({ capability: `That is ${VIDEO_DAILY_LIMIT} videos in a day — the daily limit. It resets tomorrow.` });
      }
    }

    if (req.clientKey) {
      const existing = await this.db.generation.findUnique({ where: { workspaceId_clientKey: { workspaceId: req.workspaceId, clientKey: req.clientKey } } });
      if (existing) {
        logger.info({ generationId: existing.id, workspaceId: req.workspaceId, clientKey: req.clientKey }, 'generation request replayed; returning the existing row');
        const wallet = await this.db.wallet.findUnique({ where: { workspaceId: req.workspaceId } });
        return { generation: existing, balance: wallet ? await this.ledger.balance(wallet.id) : 0 };
      }
    }

    // A multi-shot video is a PARENT priced as an ad; its shots are children the pipeline creates.
    const shots = req.capability === 'IMAGE_TO_VIDEO' ? Number(params.shots ?? 1) : 1;
    const kind = req.kind ?? (shots > 1 ? 'PARENT' : 'STANDALONE');
    const costCode = req.costCode
      ?? (shots === 4 ? 'video.ad_30s' : shots === 2 ? 'video.ad_15s' : req.capability === 'DUB' && params.lipsync === true ? DUB_LIPSYNC_COST_CODE : DEFAULT_COST_CODE[req.capability]);
    const cost = await this.db.creditCost.findUnique({ where: { code: costCode } });
    if (!cost) throw new NotFoundError(`credit cost "${costCode}"`);

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
            parentId: req.parentId ?? null,
            clientKey: req.clientKey ?? null,
            costCode: cost.code,
            credits: cost.credits,
            stage: 'queued',
            input: params as Prisma.InputJsonObject,
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
            amount: cost.credits,
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
        if (winner) return { generation: winner, balance: await this.ledger.balance(wallet.id) };
      }
      throw err;
    }

    const balance = await this.ledger.balance(wallet.id);
    logger.info(
      { generationId: generation.id, workspaceId: req.workspaceId, capability: req.capability, costCode: cost.code, credits: cost.credits, balance, parentId: req.parentId },
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
    const child = await this.db.generation.create({
      data: {
        workspaceId: parent.workspaceId,
        requestedById: parent.requestedById,
        capability,
        kind: 'CHILD',
        parentId: parent.id,
        clientKey: `${parent.id}:shot:${index}`,
        costCode: 'video.shot',
        credits: 0,
        stage: 'queued',
        input: params as Prisma.InputJsonObject,
        channel: parent.channel, apiKeyId: parent.apiKeyId, projectId: parent.projectId, merchantRef: parent.merchantRef,
      },
    });
    await this.queue.enqueue(child.id, capability);
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
      where: { id, status: 'RUNNING', kind: 'PARENT', stage: 'waiting' },
      data: { stage: 'composing', heartbeatAt: new Date() },
    });
    if (count === 0) return null;
    return this.db.generation.findUnique({ where: { id } });
  }

  /** A child checked in: its parent is alive too. */
  async touchParent(childId: string): Promise<void> {
    const child = await this.db.generation.findUnique({ where: { id: childId }, select: { parentId: true } });
    if (child?.parentId) await this.db.generation.updateMany({ where: { id: child.parentId, status: 'RUNNING' }, data: { heartbeatAt: new Date() } });
  }

  /**
   * What a generation would cost, before the customer commits. The studio
   * shows this next to the button; the balance after is what the customer
   * is really deciding about.
   */
  async quote(workspaceId: string, capability: Capability, costCode?: string): Promise<{ costCode: string; credits: number; label: string; balance: number; balanceAfter: number; expectedMs: number }> {
    const code = costCode ?? DEFAULT_COST_CODE[capability];
    const cost = await this.db.creditCost.findUnique({ where: { code } });
    if (!cost) throw new NotFoundError(`credit cost "${code}"`);
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId } });
    if (!wallet) throw new NotFoundError('wallet');
    const balance = await this.ledger.balance(wallet.id);
    return { costCode: cost.code, credits: cost.credits, label: cost.label, balance, balanceAfter: balance - cost.credits, expectedMs: EXPECTED_MS[capability] };
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
  async requeue(id: string, reason: string): Promise<void> {
    await this.db.generation.updateMany({
      where: { id, status: 'RUNNING' },
      data: { status: 'QUEUED', heartbeatAt: null, stage: 'queued', progress: 0, failureReason: reason.slice(0, 2000) },
    });
  }

  /** Outputs are stored. The debit stands; there is nothing to refund. */
  async succeed(id: string, outcome: GenerationOutcome): Promise<Generation> {
    const row = await this.claimTerminal(id);
    // The copy that came back is the most searchable thing about a text generation.
    const copyText = (outcome.outputs ?? []).filter((o) => o.role === 'text' && o.text !== undefined).map((o) => flattenText(o.text)).join(' ').trim();
    const searchText = [row.searchText, copyText].filter(Boolean).join(' ').slice(0, 8000) || undefined;
    const done = await this.db.generation.update({
      where: { id: row.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        stage: 'done',
        progress: 100,
        ...(searchText ? { searchText } : {}),
        outputs: (outcome.outputs ?? []) as unknown as Prisma.InputJsonArray,
        ...(outcome.providerKey ? { providerKey: outcome.providerKey } : {}),
        ...(outcome.providerJobId ? { providerJobId: outcome.providerJobId } : {}),
        ...(outcome.providerCostMinor !== undefined ? { providerCostMinor: outcome.providerCostMinor } : {}),
      },
    });
    this.hooks.finished(done);
    return done;
  }

  /** It ended badly. Give the credits back. */
  async fail(id: string, outcome: GenerationOutcome): Promise<Generation> {
    const row = await this.claimTerminal(id);
    if (row.credits > 0) await this.refund(row, outcome.failureReason ?? 'generation failed');
    const done = await this.db.generation.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        stage: 'failed',
        failureReason: outcome.failureReason ?? null,
        failureKind: outcome.failureKind ?? null,
        ...(outcome.providerKey ? { providerKey: outcome.providerKey } : {}),
        ...(outcome.providerJobId ? { providerJobId: outcome.providerJobId } : {}),
        ...(outcome.providerCostMinor !== undefined ? { providerCostMinor: outcome.providerCostMinor } : {}),
      },
    });
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
    const row = await this.db.generation.findUnique({ where: { id } });
    if (!row || (workspaceId && row.workspaceId !== workspaceId)) throw new NotFoundError('generation');
    if (row.status !== 'QUEUED') {
      throw new ConflictError('That generation has already started and cannot be cancelled.');
    }
    if (row.credits > 0) await this.refund(row, 'cancelled before it started');
    logger.info({ generationId: id, workspaceId: row.workspaceId, credits: row.credits }, 'generation cancelled; credits returned');
    return this.db.generation.update({
      where: { id },
      data: { status: 'CANCELLED', finishedAt: new Date(), stage: 'failed' },
    });
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
      logger.warn({ count: dispatched.length, oldest: rows[0]?.createdAt, dispatched: dispatched.slice(0, 20) }, 'dispatcher re-queued generations that had no job behind them');
    }
    return dispatched;
  }

  /**
   * Reclaim generations nobody is working on any more.
   *
   * This is what makes a lost Redis job survivable. Anything RUNNING whose
   * heartbeat has gone quiet, or anything QUEUED that was never picked up,
   * is failed and refunded. Run it on a schedule.
   *
   * Returns the ids it reclaimed, so the caller can log and alert on a number
   * that should normally be zero.
   */
  async sweepStale(now = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
    const stale = await this.db.generation.findMany({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] },
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, createdAt: { lt: cutoff } }],
      },
      select: { id: true },
      take: 100, // bounded: a backlog is drained over several runs, not one long lock
    });

    const reclaimed: string[] = [];
    for (const { id } of stale) {
      try {
        await this.fail(id, { failureReason: 'no worker heartbeat; reclaimed by the sweeper' });
        reclaimed.push(id);
      } catch (err) {
        // One poisoned row must not stop the others being refunded.
        logger.error({ err, generationId: id }, 'sweeper could not reclaim generation');
      }
    }
    if (reclaimed.length) logger.warn({ count: reclaimed.length, reclaimed }, 'generations reclaimed by the sweeper');
    return reclaimed;
  }

  /**
   * Parents whose shots have all finished but that nobody woke — the wake-up
   * enqueue failed, or the worker that ran the last shot died between the
   * update and the enqueue. The dispatcher calls this on its timer. Returns
   * what it queued so the direct-mode worker can run them itself.
   */
  async wakeReadyParents(): Promise<string[]> {
    const parents = await this.db.generation.findMany({
      where: { status: 'RUNNING', kind: 'PARENT', stage: 'waiting', children: { none: { status: { in: ['QUEUED', 'RUNNING'] } } } },
      select: { id: true, capability: true },
      take: 50,
    });
    const woken: string[] = [];
    for (const p of parents) {
      const r = await this.queue.enqueue(p.id, p.capability);
      if (r.queued) woken.push(p.id);
    }
    if (woken.length) logger.warn({ count: woken.length, woken }, 'dispatcher woke parents whose shots had all finished');
    return parents.map((p) => p.id);
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
   * Fetch a row and refuse to move it if it has already finished.
   *
   * Every terminal transition goes through here. A provider that answers twice,
   * a retried webhook, a sweeper racing a worker that just came back — all of
   * them land here and are turned away, which is what keeps the refund exactly
   * once.
   */
  private async claimTerminal(id: string): Promise<Generation> {
    const row = await this.db.generation.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('generation');
    if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
      throw new ConflictError(`That generation already ${row.status.toLowerCase()}.`);
    }
    return row;
  }

  /** Give back exactly what was taken, keyed so it can only happen once. */
  private async refund(row: Generation, reason: string): Promise<void> {
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId: row.workspaceId } });
    if (!wallet) throw new NotFoundError('wallet');
    await this.ledger.refund({
      walletId: wallet.id,
      amount: row.credits,
      idempotencyKey: generationDebitKey(row.id),
      referenceId: row.id,
      reason,
    });
  }
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
  const title = name
    || (prompt ? prompt.split(/\s+/).slice(0, 8).join(' ') : '')
    || (targetName ? `Dubbed into ${targetName}` : '')
    || (script ? script.split(/\s+/).slice(0, 8).join(' ') : '')
    || null;
  const productKey = str('productKey') || (name ? slug(name) : '') || null;
  const parts = [name, prompt, str('details'), str('price'), str('caption'), str('scene'), str('instruction'), str('field'), str('format'), str('language'), targetName, script, str('brief'), str('title'), str('genre')].filter(Boolean);
  return { title, productKey, searchText: parts.length ? parts.join(' ').slice(0, 4000) : null };
}

function slug(v: string): string {
  return v.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

/** Copy outputs are nested objects; the words are what matter. */
function flattenText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(flattenText).join(' ');
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).map(flattenText).join(' ');
  return '';
}

/** A row as the customer may see it: a vaulted song's key is not theirs until they unlock it. */
export function forCustomer<T extends Generation>(row: T): T {
  const outputs = row.outputs as Array<{ key: string; locked?: boolean }> | null;
  if (!outputs?.some((o) => o.locked)) return row;
  return { ...row, outputs: redactLocked(outputs) as unknown as Prisma.JsonValue };
}
