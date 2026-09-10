/**
 * A multi-shot ad: fifteen or thirty seconds from one product photo.
 *
 * NO MODEL MAKES THIRTY SECONDS IN ONE CALL
 * ----------------------------------------
 * Veo makes ~8 s, Sora 4–12 s, Wan 5–10 s. So an ad is a PLAN of 2–8 shots (up to a minute),
 * each its own CHILD generation rendered in parallel, stitched by us.
 *
 * THE PARENT NEVER HOLDS A WORKER WHILE IT WAITS
 * ---------------------------------------------
 * The heavy queue has two slots. A parent that sat in one polling its
 * children would, with two parents, hold both slots while the children
 * could run in neither — a deadlock that costs nothing to create and a
 * page to diagnose. So the parent runs TWICE: the first run writes the
 * plan, creates the children and returns `waiting`; the last child to
 * finish puts the parent onto media.local; the second run stitches. The
 * parent row remains IMAGE_TO_VIDEO so this pipeline still owns both passes.
 *
 * MONEY
 * -----
 * The parent holds the whole price at request time. Children carry zero
 * credits. If any shot fails for good, the parent fails and the whole
 * price comes back — a seller is never charged for three quarters of an ad.
 */

import type { Generation } from '@prisma/client';
import {
  adPlan,
  presenterWords,
  ProviderError,
  shotPlanSchema,
  SHOT_PLAN_JSON_SCHEMA,
  type CapabilityParams,
  type LlmRequest,
  type ShotPlan,
} from '@anystudio/shared';
import type { Pipeline, PipelineContext, PipelineResult } from './index';
import { renderPresenter, wantsPresenter, type PresenterClip } from './presenter';
import { renderNarration } from './narration';

const FORMAT_BRIEF: Record<CapabilityParams<'IMAGE_TO_VIDEO'>['format'], string> = {
  reveal: 'A product reveal: start close and abstract, pull back to show the whole product, end settled on it.',
  benefits: 'Three benefits, one per shot, each shot showing the product in the situation where that benefit matters.',
  before_after: 'Before and after: the problem without the product, then the product solving it, then the result.',
  unboxing: 'An unboxing: the box, the reveal, the product in hand, the product in use.',
  price_drop: 'A price-drop announcement: energetic, the product from its best angles, building to the price on the end card.',
  ugc: 'Shot like a customer filmed it on a phone: handheld feel, natural light, the product in real life.',
};

const END_CARD_MS = 2_000;
const MIN_SEGMENT_MS = 500;

/** Keep readable caption windows even for the shortest valid timeline slots. */
export function adCaptionWindow(startMs: number, durationMs: number, maxVisibleMs = durationMs): { fromMs: number; toMs: number } {
  const padding = Math.min(300, Math.floor(durationMs / 4));
  const fromMs = startMs + padding;
  return { fromMs, toMs: Math.min(startMs + durationMs - padding, fromMs + maxVisibleMs) };
}

/** Creation timestamps can tie; shot indices, not completion order, define the story. */
export function orderedAdChildren(children: Generation[], p: CapabilityParams<'IMAGE_TO_VIDEO'>): Generation[] {
  const offset = wantsPresenter(p) ? 1 : 0;
  const expected = p.shots - offset;
  const ordered = [...children].sort((a, b) => Number((a.input as { shotIndex?: number }).shotIndex) - Number((b.input as { shotIndex?: number }).shotIndex));
  if (ordered.length !== expected || ordered.some((child, i) => (child.input as { shotIndex?: number }).shotIndex !== i + offset))
    throw new ProviderError('RETRYABLE', 'the ad does not have its complete ordered set of shots', 'shots');
  return ordered;
}

export const adPipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'IMAGE_TO_VIDEO'>;
  if (ctx.resume) return assemble(ctx, p);
  return plan(ctx, p);
};

/** With a presenter, shot one is the person talking; the table's first slot is the script-writing budget. */
function presenterSeconds(p: CapabilityParams<'IMAGE_TO_VIDEO'>): number {
  return adPlan(p.shots)?.durations[0] ?? 8;
}

/**
 * Fit provider-grid clips into the exact runtime sold to the customer.
 * A presenter is speech, so its measured duration is preserved; product
 * footage absorbs the remaining trim/pad. Every allocation sums exactly.
 */
export function allocateAdTimeline(
  rawProductMs: number[],
  targetMs: number,
  options: { endCard: boolean; presenterMs?: number } = { endCard: false },
): number[] {
  const contentMs = targetMs - (options.endCard ? END_CARD_MS : 0);
  const presenterMs = options.presenterMs === undefined ? undefined : Math.max(MIN_SEGMENT_MS, Math.round(options.presenterMs));
  const productBudget = contentMs - (presenterMs ?? 0);
  if (productBudget < rawProductMs.length * MIN_SEGMENT_MS) {
    throw new ProviderError('INVALID_INPUT', 'The presenter speech is too long for this ad length. Shorten the presenter script.', 'ad-pipeline');
  }
  const fittedProducts = fitDurations(rawProductMs, productBudget);
  return presenterMs === undefined ? fittedProducts : [presenterMs, ...fittedProducts];
}

function fitDurations(rawMs: number[], targetMs: number): number[] {
  if (rawMs.length === 0) return [];
  if (targetMs < rawMs.length * MIN_SEGMENT_MS) throw new ProviderError('INVALID_INPUT', 'The requested video is too short for its shots.', 'ad-pipeline');
  const weights = rawMs.map((duration) => Math.max(MIN_SEGMENT_MS, duration));
  const weightTotal = weights.reduce((sum, duration) => sum + duration, 0);
  const distributable = targetMs - rawMs.length * MIN_SEGMENT_MS;
  const fitted = weights.map((weight) => MIN_SEGMENT_MS + Math.floor((distributable * weight) / weightTotal));
  fitted[fitted.length - 1]! += targetMs - fitted.reduce((sum, duration) => sum + duration, 0);
  return fitted;
}

/** First run: write the plan, create the shots, step aside. */
async function plan(ctx: PipelineContext, p: CapabilityParams<'IMAGE_TO_VIDEO'>): Promise<PipelineResult> {
  const withPresenter = wantsPresenter(p);
  if (p.presenter && !withPresenter)
    throw new ProviderError('INVALID_INPUT', 'a presenter needs the "filmed by a customer" format and at least two shots', 'ad-pipeline');
  if (withPresenter && !ctx.presenterLab('heygen'))
    throw new ProviderError('PROVIDER_DOWN', 'no presenter vendor is configured (HEYGEN_API_KEY); the ad cannot have a presenter here', 'presenter');

  // A one-shot reel still uses a child. That makes its provider render the
  // first pass and moves its exact-duration/aspect normalization onto the
  // isolated media.local service for the second pass.
  if (p.shots === 1) {
    await ctx.stage('routing', 20, 'sending the reel to the video model');
    const parent = await ctx.db.generation.findUniqueOrThrow({ where: { id: ctx.row.id } });
    const childParams = {
      sourceKey: p.sourceKey,
      prompt: p.prompt,
      durationSec: p.durationSec,
      aspect: p.aspect,
      motion: p.motion,
      audio: p.audio,
      shots: 1 as const,
      format: p.format,
      shotIndex: 0,
    };
    await ctx.generations.createChild(parent, 'IMAGE_TO_VIDEO', childParams, 0);
    return { artifacts: [], waiting: true };
  }

  await ctx.stage('preparing', 6, 'planning the shots');
  const saved = shotPlanSchema.safeParse((ctx.row.input as { plan?: unknown }).plan);
  let shotPlan: ShotPlan;
  let plannerProviderKey: string | undefined;
  let plannerCost = 0;
  if (saved.success) {
    // A retry after a worker restart must execute the plan already committed
    // to this parent. Asking the model again can change shot N while the
    // already-finished child N still contains the old shot, and also pays for
    // planning twice.
    shotPlan = saved.data;
    ctx.log.info({ shots: shotPlan.shots.length }, 'reusing the saved shot plan after a restart');
  } else {
    const request = planRequest(ctx, p);
    const result = await ctx.callCapability(
      'TEXT_GENERATE',
      { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, params: { task: 'shot_plan' }, files: ctx.files, prompt: request },
      { timeoutMs: 60_000, signal: ctx.signal },
    );
    const parsed = shotPlanSchema.safeParse(result.artifacts.find((a) => a.text !== undefined)?.text);
    if (!parsed.success)
      throw new ProviderError('RETRYABLE', `shot plan did not fit the schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`, result.providerKey);
    plannerProviderKey = result.providerKey;
    plannerCost = result.costMinor ?? 0;
    // With a presenter, the person is shot one and the product shots fill the rest of the table.
    const productShots = withPresenter ? p.shots - 1 : p.shots;
    shotPlan = { ...parsed.data, shots: parsed.data.shots.slice(0, productShots) };
    // A short plan is padded with the settle shot rather than refused: the customer asked for four.
    const table = adPlan(p.shots)?.durations ?? [];
    const wanted = withPresenter ? table.slice(1) : table;
    while (shotPlan.shots.length < productShots) shotPlan.shots.push({ ...shotPlan.shots[shotPlan.shots.length - 1]!, motion: 'slow push-in' });
    // The table's durations win over the planner's: they are what the price and the running time assume.
    shotPlan.shots = shotPlan.shots.map((shot, i) => ({ ...shot, durationSec: (wanted[i] ?? shot.durationSec) as 5 | 8 }));
    if (withPresenter) {
      // Their own words first; a segment already filmed on an earlier attempt keeps its words; else the planner's.
      const own = p.presenter?.script?.trim();
      shotPlan.presenterScript = (own || p.presenterClip?.script || shotPlan.presenterScript || '').trim();
      if (!shotPlan.presenterScript) throw new ProviderError('RETRYABLE', 'the planner wrote no presenter script', result.providerKey);
    }

    await ctx.db.generation.update({ where: { id: ctx.row.id }, data: { input: { ...(ctx.row.input as object), plan: shotPlan } } });
    ctx.log.info({ shots: shotPlan.shots.length, hook: shotPlan.hook, format: p.format, presenter: withPresenter }, 'shot plan written');
  }

  // The talking segment, before the shots go out: it is the slowest piece and the one a retry must not repeat.
  let presenterCost = 0;
  if (withPresenter) {
    let clip: PresenterClip | undefined = p.presenterClip;
    if (!clip) {
      const made = await renderPresenter(ctx, p, shotPlan.presenterScript!);
      clip = made.clip;
      presenterCost = made.costMinor;
      const fresh = await ctx.db.generation.findUniqueOrThrow({ where: { id: ctx.row.id } });
      await ctx.db.generation.update({ where: { id: ctx.row.id }, data: { input: { ...(fresh.input as object), presenterClip: clip } } });
    } else {
      ctx.log.info({ key: clip.key }, 'presenter already filmed on an earlier attempt; reusing it');
    }
  }

  await ctx.stage('routing', 42, `dispatching ${shotPlan.shots.length} shots`);
  const parent = await ctx.db.generation.findUniqueOrThrow({ where: { id: ctx.row.id } });
  for (const [i, shot] of shotPlan.shots.entries()) {
    await ctx.generations.createChild(
      parent,
      'IMAGE_TO_VIDEO',
      {
        sourceKey: p.sourceKey,
        prompt: shot.prompt,
        motion: shot.motion,
        durationSec: shot.durationSec,
        aspect: p.aspect,
        audio: p.audio,
        shots: 1,
        format: p.format,
        caption: shot.caption,
        shotIndex: withPresenter ? i + 1 : i,
      },
      i,
    );
  }
  return { artifacts: [], waiting: true, providerKey: plannerProviderKey, costMinor: plannerCost + presenterCost };
}

/** Second run: every child is terminal. Stitch, or fail with the whole price refunded. */
async function assemble(ctx: PipelineContext, p: CapabilityParams<'IMAGE_TO_VIDEO'>): Promise<PipelineResult> {
  const children = orderedAdChildren(await ctx.db.generation.findMany({ where: { parentId: ctx.row.id }, orderBy: { createdAt: 'asc' } }), p);
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
  const clip = wantsPresenter(p) ? p.presenterClip : undefined;
  const shotKeys = children.map((c) => videoKey(c)).filter((k): k is string => Boolean(k));
  if (shotKeys.length !== children.length) throw new ProviderError('RETRYABLE', 'a shot finished without a video output', 'shots');
  if (wantsPresenter(p) && !clip) throw new ProviderError('RETRYABLE', 'the presenter segment is missing from the row', 'presenter');

  // Captions timed to the shots: each shot's caption for the length of that shot.
  // With a presenter, the hook sits over the first seconds of them talking, then the product shots carry their own lines.
  const captions: Array<{ text: string; fromMs: number; toMs: number }> = [];
  const rawProductDurationsMs = children.map((child, i) => {
    if (p.shots === 1) return p.durationSec * 1000;
    const plannedSeconds = plan?.shots[i]?.durationSec;
    return plannedSeconds ? plannedSeconds * 1000 : (videoDurationMs(child) ?? ((child.input as { durationSec?: number }).durationSec ?? 5) * 1000);
  });
  const endCard = p.shots > 1 ? (plan?.endCard ?? { text: p.productName ?? '', price: p.price }) : undefined;
  const targetDurationMs = p.shots === 1 ? p.durationSec * 1000 : adPlan(p.shots)!.seconds * 1000;
  const shotDurationsMs = allocateAdTimeline(rawProductDurationsMs, targetDurationMs, {
    endCard: Boolean(endCard?.text),
    presenterMs: clip?.durationMs,
  });
  const productDurationsMs = clip ? shotDurationsMs.slice(1) : shotDurationsMs;
  let t = 0;
  if (clip) {
    if (plan?.hook) captions.push({ text: plan.hook, ...adCaptionWindow(0, shotDurationsMs[0]!, 3200) });
    t = shotDurationsMs[0]!;
  }
  for (const [i] of children.entries()) {
    // The stitcher trims a longer vendor grid result (Wan 10 s) or pads a
    // shorter one (for example, a 4 s fallback) to this paid timeline. Veo's
    // 5 s slot is requested as 6 s and trimmed, so it never needs a freeze.
    // Captions therefore
    // follow the plan, not the raw provider file.
    const durationMs = productDurationsMs[i]!;
    const text = !clip && i === 0 && plan?.hook ? plan.hook : (plan?.shots[i]?.caption ?? '');
    if (text) captions.push({ text, ...adCaptionWindow(t, durationMs) });
    t += durationMs;
  }
  const allKeys = clip ? [clip.key, ...shotKeys] : shotKeys;
  const narration = await renderNarration(ctx, p, targetDurationMs);
  await ctx.stage('composing', 70, `stitching ${allKeys.length} shots`);
  const files: Record<string, { key: string; url: string; mime: string }> = Object.fromEntries(
    await Promise.all(allKeys.map(async (k, i) => [`shotKeys[${i}]`, { key: k, url: await ctx.media.signRead(k, 60 * 60), mime: 'video/mp4' }] as const)),
  );
  // The presenter's speech is the ad's voiceover: laid from zero, it lines up with the lips in shot one.
  if (clip) files.voiceoverKey = { key: clip.audioKey, url: await ctx.media.signRead(clip.audioKey, 60 * 60), mime: 'audio/mpeg' };
  else if (narration) files.voiceoverKey = { key: narration.key, url: await ctx.media.signRead(narration.key, 60 * 60), mime: narration.mime };
  const stitched = await ctx.callCapability(
    'VIDEO_STITCH',
    {
      generationId: ctx.row.id,
      workspaceId: ctx.row.workspaceId,
      params: {
        shotKeys: allKeys,
        shotDurationsMs,
        targetDurationMs,
        preserveShotAudio: p.audio,
        muteShotAudio: clip ? [0] : undefined,
        aspect: p.aspect,
        captions,
        endCard: endCard?.text ? endCard : undefined,
        watermark: true,
        voiceoverKey: clip?.audioKey ?? narration?.key,
      },
      files,
    },
    { timeoutMs: 5 * 60_000, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('composing', progress ?? 80, detail) },
  );
  const shotsCost = children.reduce((sum, c) => sum + (c.providerCostMinor ?? 0), 0);
  ctx.log.info({ shots: children.length, shotsCostMinor: shotsCost, contentMs: t, targetDurationMs }, 'ad assembled');
  return {
    artifacts: stitched.artifacts,
    providerKey: stitched.providerKey,
    providerJobId: stitched.providerJobId,
    // The stitch is local/free. Parent-owned planner/presenter calls are read
    // from its durable attempt journal by the runner; only child rows need to
    // be inherited here.
    inheritedCostMinor: shotsCost,
    costMinor: shotsCost + (stitched.costMinor ?? 0),
  };
}

function videoKey(child: Generation): string | null {
  const outputs = (child.outputs as Array<{ role: string; key: string }> | null) ?? [];
  return outputs.find((o) => o.role === 'video')?.key ?? null;
}

/** How long the shot came back, when the adapter that made it said so. */
function videoDurationMs(child: Generation): number | null {
  const outputs = (child.outputs as Array<{ role: string; durationMs?: number }> | null) ?? [];
  const d = outputs.find((o) => o.role === 'video')?.durationMs;
  return typeof d === 'number' && d > 0 ? d : null;
}

/** "8, 8, 8 and 5" */
const durationsPhrase = (d: readonly number[]) => (d.length < 2 ? String(d[0] ?? 8) : `${d.slice(0, -1).join(', ')} and ${d[d.length - 1]}`);

function planRequest(ctx: PipelineContext, p: CapabilityParams<'IMAGE_TO_VIDEO'>): LlmRequest {
  const tone = ctx.brandKit?.tone ?? 'warm, direct, confident';
  const profile = (ctx.workspace.profile as Record<string, unknown> | null) ?? {};
  const system = [
    'You are a director planning a short vertical product ad for social media, to be generated shot by shot by an image-to-video model from ONE reference photo of the product.',
    `Format: ${FORMAT_BRIEF[p.format]}`,
    wantsPresenter(p)
      ? [
          `A presenter speaks to camera FIRST, for about ${presenterSeconds(p)} seconds; that is not one of your shots. Write it as presenterScript: a factual product introduction, ${presenterWords(presenterSeconds(p))} words or so, the product's name, a visible or supplied detail, and how to order if supplied. Do not invent personal experience, testimonials or product claims. Spoken language — no hashtags, no emoji, no brackets.`,
          `Then exactly ${p.shots - 1} product shots. Durations: ${durationsPhrase((adPlan(p.shots)?.durations ?? [8, 5]).slice(1))} seconds, in that order.`,
        ].join('\n')
      : `Exactly ${p.shots} shots. Durations: ${durationsPhrase(adPlan(p.shots)?.durations ?? [8, 5])} seconds, in that order.`,
    `Voice: ${tone}.`,
    "Rules for shots: each prompt describes what the camera sees with the product identical to the reference (same shape, colours, label); one clear camera move per shot; no text in the video frame (captions are added later); product-only footage, do not add people or a visible presenter (any requested presenter is filmed separately); realistic lighting; keep every prompt under 60 words. Each shot's caption is under 8 words of on-screen text.",
    'The first shot is the hook. The last shot settles on the product for the end card.',
    profile.sells ? `What this seller sells: ${String(profile.sells)}.` : '',
    'Return only the structure requested.',
  ]
    .filter(Boolean)
    .join('\n');
  const parts: LlmRequest['parts'] = [];
  if (ctx.files.sourceKey) parts.push({ imageUrl: ctx.files.sourceKey.url, mime: ctx.files.sourceKey.mime });
  parts.push({
    text: [
      p.productName ? `Product: ${p.productName}` : 'Product: identify it from the photo',
      p.details ? `Details: ${p.details}` : '',
      p.price ? `Price to show on the end card: ${p.price}` : '',
      p.prompt ? `The seller's own direction: ${p.prompt}` : '',
      p.presenter?.script ? `The presenter's words are already written by the seller; do not write presenterScript.` : '',
      'Plan the ad.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  return { system, parts, jsonSchema: SHOT_PLAN_JSON_SCHEMA, maxTokens: 1500, temperature: 0.8 };
}
