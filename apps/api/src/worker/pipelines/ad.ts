/**
 * A multi-shot ad: fifteen or thirty seconds from one product photo.
 *
 * NO MODEL MAKES THIRTY SECONDS IN ONE CALL
 * ----------------------------------------
 * Veo makes ~8 s, Sora 4–12 s, Wan 5–10 s. So an ad is a PLAN of 2–4 shots,
 * each its own CHILD generation rendered in parallel, stitched by us.
 *
 * THE PARENT NEVER HOLDS A WORKER WHILE IT WAITS
 * ---------------------------------------------
 * The heavy queue has two slots. A parent that sat in one polling its
 * children would, with two parents, hold both slots while the children
 * could run in neither — a deadlock that costs nothing to create and a
 * page to diagnose. So the parent runs TWICE: the first run writes the
 * plan, creates the children and returns `waiting`; the last child to
 * finish puts the parent back on the queue; the second run stitches.
 *
 * MONEY
 * -----
 * The parent holds the whole price at request time. Children carry zero
 * credits. If any shot fails for good, the parent fails and the whole
 * price comes back — a seller is never charged for three quarters of an ad.
 */

import type { Generation } from '@prisma/client';
import { ProviderError, shotPlanSchema, SHOT_PLAN_JSON_SCHEMA, type CapabilityParams, type LlmRequest, type ShotPlan } from '@anystudio/shared';
import type { Pipeline, PipelineContext, PipelineResult } from './index';

const FORMAT_BRIEF: Record<CapabilityParams<'IMAGE_TO_VIDEO'>['format'], string> = {
  reveal: 'A product reveal: start close and abstract, pull back to show the whole product, end settled on it.',
  benefits: 'Three benefits, one per shot, each shot showing the product in the situation where that benefit matters.',
  before_after: 'Before and after: the problem without the product, then the product solving it, then the result.',
  unboxing: 'An unboxing: the box, the reveal, the product in hand, the product in use.',
  price_drop: 'A price-drop announcement: energetic, the product from its best angles, building to the price on the end card.',
  ugc: 'Shot like a customer filmed it on a phone: handheld feel, natural light, the product in real life.',
};

export const adPipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'IMAGE_TO_VIDEO'>;
  if (ctx.resume) return assemble(ctx, p);
  return plan(ctx, p);
};

/** First run: write the plan, create the shots, step aside. */
async function plan(ctx: PipelineContext, p: CapabilityParams<'IMAGE_TO_VIDEO'>): Promise<PipelineResult> {
  await ctx.stage('preparing', 6, 'planning the shots');
  const request = planRequest(ctx, p);
  const result = await ctx.callCapability('TEXT_GENERATE', { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, params: { task: 'shot_plan' }, files: ctx.files, prompt: request }, { timeoutMs: 60_000, signal: ctx.signal });
  const parsed = shotPlanSchema.safeParse(result.artifacts.find((a) => a.text !== undefined)?.text);
  if (!parsed.success) throw new ProviderError('RETRYABLE', `shot plan did not fit the schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`, result.providerKey);
  const shotPlan: ShotPlan = { ...parsed.data, shots: parsed.data.shots.slice(0, p.shots) };
  // A short plan is padded with the settle shot rather than refused: the customer asked for four.
  while (shotPlan.shots.length < p.shots) shotPlan.shots.push({ ...shotPlan.shots[shotPlan.shots.length - 1]!, motion: 'slow push-in' });

  await ctx.db.generation.update({ where: { id: ctx.row.id }, data: { input: { ...(ctx.row.input as object), plan: shotPlan } } });
  ctx.log.info({ shots: shotPlan.shots.length, hook: shotPlan.hook, format: p.format }, 'shot plan written');

  await ctx.stage('routing', 12, `dispatching ${shotPlan.shots.length} shots`);
  const parent = await ctx.db.generation.findUniqueOrThrow({ where: { id: ctx.row.id } });
  for (const [i, shot] of shotPlan.shots.entries()) {
    await ctx.generations.createChild(parent, 'IMAGE_TO_VIDEO', {
      sourceKey: p.sourceKey, prompt: shot.prompt, motion: shot.motion, durationSec: shot.durationSec, aspect: p.aspect, audio: false, shots: 1, format: p.format, caption: shot.caption, shotIndex: i,
    }, i);
  }
  return { artifacts: [], waiting: true, providerKey: result.providerKey, costMinor: result.costMinor };
}

/** Second run: every child is terminal. Stitch, or fail with the whole price refunded. */
async function assemble(ctx: PipelineContext, p: CapabilityParams<'IMAGE_TO_VIDEO'>): Promise<PipelineResult> {
  const children = await ctx.db.generation.findMany({ where: { parentId: ctx.row.id }, orderBy: { createdAt: 'asc' } });
  const failed = children.filter((c) => c.status !== 'SUCCEEDED');
  if (failed.length) {
    const first = failed[0]!;
    throw new ProviderError(
      (first.failureKind as ProviderError['kind'] | null) ?? 'RETRYABLE',
      `${failed.length} of ${children.length} shots failed: ${failed.map((c) => `${c.id.slice(0, 8)} ${c.failureKind ?? c.status}`).join(', ')}`,
      first.providerKey ?? 'shots',
    );
  }
  const plan = (ctx.row.input as { plan?: ShotPlan }).plan;
  const shotKeys = children.map((c) => videoKey(c)).filter((k): k is string => Boolean(k));
  if (shotKeys.length !== children.length) throw new ProviderError('RETRYABLE', 'a shot finished without a video output', 'shots');

  // Captions timed to the shots: each shot's caption for the length of that shot.
  const captions: Array<{ text: string; fromMs: number; toMs: number }> = [];
  let t = 0;
  for (const [i, c] of children.entries()) {
    const durationMs = (c.input as { durationSec?: number }).durationSec ? (c.input as { durationSec: number }).durationSec * 1000 : 5000;
    const text = i === 0 && plan?.hook ? plan.hook : (plan?.shots[i]?.caption ?? '');
    if (text) captions.push({ text, fromMs: t + 300, toMs: t + durationMs - 300 });
    t += durationMs;
  }
  const endCard = plan?.endCard ?? { text: p.productName ?? '', price: p.price };
  await ctx.stage('composing', 70, `stitching ${children.length} shots`);
  const files = Object.fromEntries(await Promise.all(shotKeys.map(async (k, i) => [`shotKeys[${i}]`, { url: await ctx.media.signRead(k, 60 * 60), mime: 'video/mp4' }] as const)));
  const stitched = await ctx.callCapability(
    'VIDEO_STITCH',
    { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, params: { shotKeys, aspect: p.aspect, captions, endCard: endCard.text ? endCard : undefined, watermark: true }, files },
    { timeoutMs: 5 * 60_000, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('composing', progress ?? 80, detail) },
  );
  const shotsCost = children.reduce((sum, c) => sum + (c.providerCostMinor ?? 0), 0);
  ctx.log.info({ shots: children.length, shotsCostMinor: shotsCost, totalMs: t }, 'ad assembled');
  return { artifacts: stitched.artifacts, providerKey: stitched.providerKey, providerJobId: stitched.providerJobId, costMinor: shotsCost + (stitched.costMinor ?? 0) };
}

function videoKey(child: Generation): string | null {
  const outputs = (child.outputs as Array<{ role: string; key: string }> | null) ?? [];
  return outputs.find((o) => o.role === 'video')?.key ?? null;
}

function planRequest(ctx: PipelineContext, p: CapabilityParams<'IMAGE_TO_VIDEO'>): LlmRequest {
  const tone = ctx.brandKit?.tone ?? 'warm, direct, confident';
  const profile = (ctx.workspace.profile as Record<string, unknown> | null) ?? {};
  const system = [
    'You are a director planning a short vertical product ad for social media, to be generated shot by shot by an image-to-video model from ONE reference photo of the product.',
    `Format: ${FORMAT_BRIEF[p.format]}`,
    `Exactly ${p.shots} shots. Durations: ${p.shots === 2 ? '8 and 8' : '8, 8, 8 and 5'} seconds, in that order.`,
    `Voice: ${tone}.`,
    'Rules for shots: each prompt describes what the camera sees with the product identical to the reference (same shape, colours, label); one clear camera move per shot; no text in the video frame (captions are added later); no people unless the format is ugc; realistic lighting; keep every prompt under 60 words. Each shot\'s caption is under 8 words of on-screen text.',
    'The first shot is the hook. The last shot settles on the product for the end card.',
    profile.sells ? `What this seller sells: ${String(profile.sells)}.` : '',
    'Return only the structure requested.',
  ].filter(Boolean).join('\n');
  const parts: LlmRequest['parts'] = [];
  if (ctx.files.sourceKey) parts.push({ imageUrl: ctx.files.sourceKey.url, mime: ctx.files.sourceKey.mime });
  parts.push({ text: [p.productName ? `Product: ${p.productName}` : 'Product: identify it from the photo', p.details ? `Details: ${p.details}` : '', p.price ? `Price to show on the end card: ${p.price}` : '', p.prompt ? `The seller's own direction: ${p.prompt}` : '', 'Plan the ad.'].filter(Boolean).join('\n') });
  return { system, parts, jsonSchema: SHOT_PLAN_JSON_SCHEMA, maxTokens: 1500, temperature: 0.8 };
}
