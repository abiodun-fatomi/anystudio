/**
 * The public API, as a thin translation over the same services the studio
 * uses. Nothing here decides prices or validates params — GenerationService
 * does — this file shapes the request from a key's point of view (the key
 * implies the workspace and project) and the response for a machine (signed
 * URLs inline, a failure the caller can act on).
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient, type ApiKey, type Generation } from '@prisma/client';
import { z } from 'zod';
import {
  API_SCENARIOS,
  PUBLIC_CAPABILITIES,
  DEFAULT_COST_CODE,
  DUB_LANGUAGES,
  PIPELINE_WRITTEN_KEYS,
  capabilityParams,
  inspectOutputSchema,
  parseCapabilityParams,
  withoutPipelineFields,
  type Capability,
  type InspectOutput,
} from '@anystudio/shared';
import { NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { GenerationEvents } from '../generation/generation.events';
import { GenerationService, customerMessage } from '../generation/generation.service';
import { LedgerService } from '../ledger/ledger.service';
import { MediaService } from '../media/media.service';
import { WebhookDispatcher } from './webhook.dispatcher';
import type { ApiCreateGenerationDto, ApiInspectDto, ApiListGenerationsDto, ApiQuoteGenerationDto } from './public-api.dto';

/**
 * How long POST /inspect holds the connection for the verdict.
 *
 * A vision call answers in a few seconds; twenty is enough for a slow model
 * and a retry. Past that the caller gets the generation back with 202 and
 * finishes the way every other generation finishes — by webhook or by
 * polling — rather than a request that hangs until a load balancer cuts it.
 */
export const INSPECT_WAIT_MS = 20_000;

const CAPABILITY_BLURB: Record<Capability, string> = {
  IMAGE_GENERATE: 'An image from a prompt — flyers, posters, scenes with no source photo.',
  IMAGE_EDIT: 'A product photo edited into a scene, branded and exported in selected sizes. Review product fidelity before publishing.',
  BACKGROUND_REMOVE: 'The product cut out, on transparency or a flat colour.',
  BACKGROUND_REPLACE: 'A new background behind the product, with a natural shadow and matched lighting.',
  RELIGHT: 'The product relit to match a described light.',
  UPSCALE: 'A sharper, larger version of an image.',
  COLLAGE: 'Several photos laid out in one picture — a grid, a lead photo with a strip, before and after — branded and exported in every size.',
  BATCH: 'The same edit applied to a whole folder: one request, priced per photo, one result per photo. Partial failures refund only their share.',
  PRODUCT_SHOT:
    'The shot a merchant needs, by name: on a model, ghost mannequin, flat lay, pressed, studio, recoloured, retouched or widened. One call, seconds.',
  IMAGE_TO_VIDEO: 'A short reel from a photo, or a 15/30-second multi-shot ad with captions and an end card.',
  VIDEO_STITCH: 'Internal: assembling an ad from its shots.',
  TEXT_GENERATE: 'Product descriptions, captions per platform, hashtags, alt text and SEO copy, in the brand voice.',
  VOICEOVER: 'A script read by a catalogue voice.',
  MUSIC: 'A song from a brief: a 30-second preview first; the full track is unlocked with a second call.',
  DUB: 'A video spoken again in another language in the same voice, lips optionally re-animated.',
  LIPSYNC: 'New words on an existing video — from an audio file or a script — with the mouth re-animated.',
  INSPECT:
    'Is this photo the product? A verdict, the reasons from a fixed list, and one sentence of advice for the merchant. POST /inspect answers inline; this route answers by webhook.',
};

const TERMINAL: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

export interface InspectResponse {
  inspection: InspectOutput | null;
  generation: Awaited<ReturnType<WebhookDispatcher['generationPayload']>>;
  balance: number;
}

@Injectable()
export class PublicApiService {
  constructor(
    private readonly db: PrismaClient,
    private readonly generations: GenerationService,
    private readonly ledger: LedgerService,
    private readonly media: MediaService,
    private readonly webhooks: WebhookDispatcher,
    private readonly events: GenerationEvents,
  ) {}

  /** What can be asked for, what it costs, and the shape of its params — derived from the schemas, never hand-written. */
  async capabilities() {
    const costs = await this.db.creditCost.findMany();
    const price = new Map(costs.map((c) => [c.code, c]));
    return PUBLIC_CAPABILITIES.map((c) => {
      const cost = price.get(DEFAULT_COST_CODE[c]);
      return {
        capability: c,
        description: CAPABILITY_BLURB[c],
        costCode: DEFAULT_COST_CODE[c],
        credits: cost?.credits ?? null,
        params: describeSchema(capabilityParams[c]).filter((field) => !PIPELINE_WRITTEN_KEYS.includes(field.name) && field.name !== 'negativePrompt'),
        pricing: 'Base rate only; POST /generations/quote with complete params for the request total.',
        examples: API_SCENARIOS.filter((scenario) => scenario.body.capability === c),
      };
    });
  }

  async balance(key: ApiKey) {
    const wallet = await this.db.wallet.findUniqueOrThrow({ where: { workspaceId: key.workspaceId }, select: { id: true, currency: true } });
    return { credits: await this.ledger.balance(wallet.id), currency: wallet.currency };
  }

  async create(key: ApiKey, dto: ApiCreateGenerationDto) {
    this.assertPublicCapability(dto.capability);
    const { generation, balance } = await this.generations.request({
      workspaceId: key.workspaceId,
      requestedById: key.createdById,
      capability: dto.capability,
      params: dto.params,
      clientKey: dto.clientKey ?? `api:${crypto.randomUUID()}`,
      channel: 'API',
      apiKeyId: key.id,
      projectId: key.projectId,
      merchantRef: dto.merchantRef,
    });
    return { generation: await this.webhooks.generationPayload(generation), balance };
  }

  async get(key: ApiKey, id: string) {
    const row = await this.own(key, id);
    return { generation: await this.webhooks.generationPayload(row) };
  }

  /**
   * Is this photo the product? Asked inline.
   *
   * It is an ordinary INSPECT generation underneath — the same row, the same
   * debit, the same per-project and per-merchant metering, the same webhook
   * — so nothing about billing or usage has a second path. What this method
   * adds is the wait: it watches the row the way the studio's progress
   * stream does, Redis when it can and the row when it cannot, and answers
   * the moment the verdict lands.
   *
   * Three outcomes, and the caller can tell them apart without parsing prose:
   *   `inspection` set          — done; the verdict is inline.        (200)
   *   `inspection` null, FAILED — could not be checked; credit back.  (200)
   *   `inspection` null, still running — the queue was slow; poll or
   *                                       wait for the webhook.         (202)
   */
  async inspect(key: ApiKey, dto: ApiInspectDto, waitMs = INSPECT_WAIT_MS): Promise<{ status: 200 | 202; body: InspectResponse }> {
    const { generation: created, balance } = await this.generations.request({
      workspaceId: key.workspaceId,
      requestedById: key.createdById,
      capability: 'INSPECT',
      params: { sourceKey: dto.sourceKey, ...(dto.declared ? { declared: dto.declared } : {}) },
      clientKey: dto.clientKey ?? `api:${crypto.randomUUID()}`,
      channel: 'API',
      apiKeyId: key.id,
      projectId: key.projectId,
      merchantRef: dto.merchantRef,
    });

    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), waitMs);
    let finished = TERMINAL.has(created.status);
    try {
      if (!finished) {
        for await (const e of this.events.watch(created.id, abort.signal)) {
          if (e.type === 'done') {
            finished = true;
            break;
          }
        }
      }
    } finally {
      clearTimeout(deadline);
    }

    const row = finished ? ((await this.db.generation.findUnique({ where: { id: created.id } })) ?? created) : created;
    const generation = await this.webhooks.generationPayload(row);
    const inspection = row.status === 'SUCCEEDED' ? this.verdictOf(row) : null;
    if (!finished) logger.info({ generationId: row.id, workspaceId: key.workspaceId, waitMs }, 'inspect: no verdict within the wait; answering 202');
    return { status: finished ? 200 : 202, body: { inspection, generation, balance } };
  }

  /** The verdict from a finished INSPECT row — validated on the way out as it was on the way in. */
  private verdictOf(row: Generation): InspectOutput | null {
    const text = ((row.outputs as Array<{ role?: string; text?: unknown }> | null) ?? []).find((o) => o.role === 'text')?.text;
    const parsed = inspectOutputSchema.safeParse(text);
    if (parsed.success) return parsed.data;
    logger.error({ generationId: row.id, issues: parsed.error.issues.slice(0, 3) }, 'inspect: a SUCCEEDED row carries a verdict that does not fit the schema');
    return null;
  }

  async list(key: ApiKey, q: ApiListGenerationsDto) {
    const limit = q.limit ?? 50;
    const rows = await this.db.generation.findMany({
      where: {
        workspaceId: key.workspaceId,
        projectId: key.projectId,
        channel: 'API',
        kind: { not: 'CHILD' },
        deletedAt: null,
        ...(q.merchantRef ? { merchantRef: q.merchantRef } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      generations: page.map((g) => ({
        id: g.id,
        status: g.status,
        capability: g.capability,
        clientKey: g.clientKey,
        merchantRef: g.merchantRef,
        credits: g.credits,
        createdAt: g.createdAt,
        finishedAt: g.finishedAt,
        ...(g.status === 'FAILED' ? { failure: { kind: g.failureKind, message: customerMessage(g) } } : {}),
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async cancel(key: ApiKey, id: string) {
    await this.own(key, id);
    const row = await this.generations.cancel(id, key.workspaceId);
    return { generation: await this.webhooks.generationPayload(row) };
  }

  async uploadFromUrl(key: ApiKey, url: string) {
    const asset = await this.media.ingestUrl(key.workspaceId, key.createdById, url);
    return { upload: this.assetView(asset) };
  }

  async presign(key: ApiKey, file: { filename: string; mime: string; bytes: number }) {
    const p = await this.media.presignUpload(key.workspaceId, key.createdById, file);
    return { upload: { id: p.assetId, key: p.key, url: p.url, method: p.method, headers: p.headers, expiresInSec: p.expiresInSec } };
  }

  async complete(key: ApiKey, assetId: string) {
    return { upload: this.assetView(await this.media.complete(key.workspaceId, assetId)) };
  }

  dubLanguages() {
    return { languages: DUB_LANGUAGES.map((l) => ({ code: l.code, name: l.name, region: l.region })) };
  }

  async quote(key: ApiKey, dto: ApiQuoteGenerationDto) {
    this.assertPublicCapability(dto.capability);
    const parsed = parseCapabilityParams(dto.capability, withoutPipelineFields(dto.params));
    if (!parsed.ok) throw new ValidationError(parsed.issues);
    return this.generations.quote(key.workspaceId, dto.capability, parsed.params as Record<string, unknown>);
  }

  private assertPublicCapability(capability: Capability) {
    if (!(PUBLIC_CAPABILITIES as readonly string[]).includes(capability))
      throw new ValidationError({ capability: 'That capability is internal, not customer-callable.' });
  }

  async own(key: ApiKey, id: string): Promise<Generation> {
    const row = await this.db.generation.findUnique({ where: { id } });
    // A key sees its own project's rows, and nothing from a sibling project — projects are the org's own boundary.
    if (!row || row.workspaceId !== key.workspaceId || row.projectId !== key.projectId || row.channel !== 'API' || row.kind === 'CHILD' || row.deletedAt)
      throw new NotFoundError('generation');
    return row;
  }

  private assetView(a: {
    id: string;
    key: string;
    status: string;
    mime: string | null;
    bytes: number | null;
    width: number | null;
    height: number | null;
    filename: string | null;
  }) {
    return { id: a.id, key: a.key, status: a.status, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height, filename: a.filename };
  }
}

/**
 * A readable summary of a Zod object: field, type, whether it is required,
 * its default, and the values an enum takes. Reads `_def.typeName` rather
 * than using instanceof: the schemas come from the shared package, which
 * may resolve its own copy of zod.
 */
export function describeSchema(
  schema: z.ZodTypeAny,
): Array<{ name: string; type: string; required: boolean; default?: unknown; values?: unknown[]; description?: string }> {
  const kind = (s: z.ZodTypeAny): string => String((s._def as { typeName?: string }).typeName ?? '');
  let inner: z.ZodTypeAny = schema;
  while (kind(inner) === 'ZodEffects') inner = (inner._def as { schema: z.ZodTypeAny }).schema;
  if (kind(inner) !== 'ZodObject') return [];
  const shape = (inner as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodTypeAny>;
  return Object.entries(shape).map(([name, field]) => {
    let f: z.ZodTypeAny = field;
    let required = true;
    let def: unknown;
    for (;;) {
      const k = kind(f);
      if (k === 'ZodOptional') {
        required = false;
        f = (f._def as { innerType: z.ZodTypeAny }).innerType;
        continue;
      }
      if (k === 'ZodDefault') {
        required = false;
        def = (f._def as { defaultValue: () => unknown }).defaultValue();
        f = (f._def as { innerType: z.ZodTypeAny }).innerType;
        continue;
      }
      if (k === 'ZodEffects') {
        f = (f._def as { schema: z.ZodTypeAny }).schema;
        continue;
      }
      break;
    }
    const k = kind(f);
    const options = k === 'ZodUnion' ? (f._def as { options: z.ZodTypeAny[] }).options : [];
    const literalUnion = options.length > 0 && options.every((option) => kind(option) === 'ZodLiteral');
    const values =
      k === 'ZodEnum'
        ? (f._def as { values: string[] }).values
        : k === 'ZodLiteral'
          ? [(f._def as { value: unknown }).value]
          : literalUnion
            ? options.map((option) => (option._def as { value: unknown }).value)
            : undefined;
    const type = literalUnion
      ? [...new Set(values!.map((value) => typeof value))].join(' | ')
      : ((
          {
            ZodString: 'string',
            ZodNumber: 'number',
            ZodBoolean: 'boolean',
            ZodArray: 'array',
            ZodEnum: 'enum',
            ZodLiteral: 'literal',
            ZodObject: 'object',
            ZodUnion: 'union',
          } as Record<string, string>
        )[k] ?? 'unknown');
    const description = field.description ?? f.description;
    return { name, type, required, ...(def !== undefined ? { default: def } : {}), ...(values ? { values } : {}), ...(description ? { description } : {}) };
  });
}
