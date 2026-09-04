/**
 * Copy: descriptions, captions, hashtags, alt text, SEO — shot plans — and
 * one field written again.
 *
 * THE PROMPT IS THE PRODUCT HERE
 * ------------------------------
 * Everything that makes the output sound like this seller and sell in this
 * market is assembled below from three sources the adapter never sees: the
 * workspace profile (the welcome answers), the brand kit's tone, and the
 * market. The model is shown the photo itself, not a description of it — a
 * multimodal model reads a label better than a customer types one.
 *
 * VALIDATED, OR REFUNDED
 * ----------------------
 * The result is parsed against the Zod schema. A miss is retried once with
 * the validation errors quoted back to the model; a second miss fails the
 * generation and the credits come back. The customer never sees half copy.
 *
 * UNIQUE, OR WRITTEN AGAIN
 * ------------------------
 * A description is fingerprinted and compared with the workspace's recent
 * ones (uniqueness.ts). A near-duplicate of a DIFFERENT product is written
 * again with the shared phrasing quoted back; the second version ships
 * either way, flagged in the log. A catalogue of forty bags gets forty
 * descriptions, not one paragraph with the colour changed.
 */

import {
  COPY_FIELDS, COPY_JSON_SCHEMA, FIELD_JSON_SCHEMA, PLATFORM_LIMITS, ProviderError, SHOT_PLAN_JSON_SCHEMA,
  copyOutputSchema, fieldOutputSchema, shotPlanSchema, type CapabilityParams, type CopyOutput, type LlmRequest,
} from '@anystudio/shared';
import type { z } from 'zod';
import type { Pipeline, PipelineContext } from './index';
import { NEAR_DUPLICATE, minhash, sharedPhrases, similarity } from './uniqueness';

const LANGUAGE: Record<string, { name: string; guidance: string }> = {
  en: { name: 'English', guidance: '' },
  'en-NG': { name: 'Nigerian English', guidance: 'Natural Nigerian register: "abeg", "sharp sharp" only if the seller\'s own words use them; prices in naira; "DM to order" is normal.' },
  pcm: { name: 'Nigerian Pidgin', guidance: 'Write real Pidgin as spoken in Lagos, not English with "dey" sprinkled in. Keep product names and specs in English. Hashtags in English.' },
  yo: { name: 'Yoruba', guidance: 'Use correct tone marks (àmì ohùn) and subdots (ẹ, ọ, ṣ). Keep product names, sizes and prices as given. Hashtags in English.' },
  ig: { name: 'Igbo', guidance: 'Use standard Igbo orthography with dotted letters (ị, ọ, ụ) and tone where it changes meaning. Keep product names and prices as given. Hashtags in English.' },
  ha: { name: 'Hausa', guidance: 'Use standard Hausa (Boko) with hooked letters (ɓ, ɗ, ƙ). Keep product names and prices as given. Hashtags in English.' },
  fr: { name: 'French', guidance: 'West African French register; keep prices as given.' },
  sw: { name: 'Swahili', guidance: 'East African Swahili; keep prices as given.' },
  pt: { name: 'Portuguese', guidance: '' },
  es: { name: 'Spanish', guidance: '' },
  ar: { name: 'Arabic', guidance: 'Modern Standard Arabic with a light Gulf/Levantine warmth; numbers as given.' },
};

export const copyPipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'TEXT_GENERATE'>;
  const tone = ctx.brandKit?.tone ?? null;
  const profile = (ctx.workspace.profile as Record<string, unknown> | null) ?? {};

  if (p.task === 'field') return rewriteField(ctx, p, profile, tone);
  if (p.task === 'shot_plan') return ask(ctx, p, shotPlanRequest(p, ctx, profile, tone), shotPlanSchema);

  // Product copy: write, validate, then make sure it is not a copy of a neighbour.
  const request = copyRequest(p, ctx, profile, tone);
  let result = await ask(ctx, p, request, copyOutputSchema);
  const copy = result.artifacts[0]!.text as CopyOutput;

  await ctx.stage('composing', 80, 'checking it does not repeat your other listings');
  const clash = await nearestDuplicate(ctx, copy.description.long, p.productKey);
  if (clash) {
    ctx.log.warn({ similarity: clash.similarity, against: clash.generationId, phrases: clash.phrases }, 'description is a near-duplicate of another listing; writing it again');
    const again: LlmRequest = {
      ...request,
      temperature: 0.95,
      parts: [...request.parts, { text: `This seller already has a listing that reads too much like yours. Write a genuinely different description and captions — different opening, different structure, different selling angle. Do not reuse these phrases: ${clash.phrases.map((s) => `"${s}"`).join(', ')}.` }],
    };
    try {
      result = await ask(ctx, p, again, copyOutputSchema);
    } catch (err) {
      ctx.log.warn({ err: err instanceof Error ? err.message : err }, 'second attempt failed; shipping the first');
    }
  }
  const final = result.artifacts[0]!.text as CopyOutput;
  await ctx.db.copyFingerprint.create({ data: { workspaceId: ctx.row.workspaceId, generationId: ctx.row.id, productKey: p.productKey ?? null, minhash: minhash(final.description.long) } });
  return result;
};

/** One call, validated; a miss is retried once with the errors quoted back. */
async function ask<S extends z.ZodTypeAny>(ctx: PipelineContext, p: CapabilityParams<'TEXT_GENERATE'>, request: LlmRequest, schema: S) {
  let lastIssues: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const req: LlmRequest = lastIssues
      ? { ...request, parts: [...request.parts, { text: `Your previous answer did not fit the required structure:\n${lastIssues}\nAnswer again, fixing exactly those problems.` }] }
      : request;
    const result = await ctx.callProvider(
      { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, capability: 'TEXT_GENERATE', params: p, files: ctx.files, prompt: req },
      { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail) => void ctx.stage('generating', 50, detail) },
    );
    const text = result.artifacts.find((a) => a.text !== undefined)?.text;
    const parsed = schema.safeParse(text);
    if (parsed.success) {
      return { artifacts: [{ mime: 'application/json' as const, role: 'text' as const, text: parsed.data as z.infer<S> }], providerKey: result.providerKey, providerJobId: result.providerJobId, costMinor: result.costMinor };
    }
    lastIssues = parsed.error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    ctx.log.warn({ attempt, issues: lastIssues, providerKey: result.providerKey }, 'copy did not fit the schema; asking again with the errors');
  }
  throw new ProviderError('RETRYABLE', `copy failed schema validation twice: ${lastIssues}`, 'copy-pipeline');
}

/** The closest recent description in the workspace that is not this product's own. */
async function nearestDuplicate(ctx: PipelineContext, text: string, productKey?: string) {
  const mine = minhash(text);
  const recent = await ctx.db.copyFingerprint.findMany({
    where: { workspaceId: ctx.row.workspaceId, ...(productKey ? { NOT: { productKey } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { generationId: true, minhash: true },
  });
  let best: { generationId: string; similarity: number } | null = null;
  for (const r of recent) {
    const s = similarity(mine, r.minhash);
    if (s >= NEAR_DUPLICATE && (!best || s > best.similarity)) best = { generationId: r.generationId, similarity: s };
  }
  if (!best) return null;
  const other = await ctx.db.generation.findUnique({ where: { id: best.generationId }, select: { outputs: true } });
  const otherText = ((other?.outputs as Array<{ role: string; text?: CopyOutput }> | null) ?? []).find((o) => o.role === 'text')?.text?.description?.long ?? '';
  return { ...best, phrases: sharedPhrases(text, otherText) };
}

function market(ctx: PipelineContext): string {
  return ({ ng: 'Nigeria', gh: 'Ghana', ke: 'Kenya', za: 'South Africa', uk: 'United Kingdom', us: 'United States' } as Record<string, string>)[ctx.workspace.region] ?? ctx.workspace.region;
}

function voice(p: CapabilityParams<'TEXT_GENERATE'>, tone: string | null): string {
  return tone ?? p.tone ?? 'warm, direct, confident, never hype';
}

function copyRequest(p: CapabilityParams<'TEXT_GENERATE'>, ctx: PipelineContext, profile: Record<string, unknown>, tone: string | null): LlmRequest {
  const lang = LANGUAGE[p.language] ?? { name: p.language, guidance: '' };
  const platforms = p.platforms;
  const limits = platforms.map((pl) => `${pl}: caption ≤ ${PLATFORM_LIMITS[pl].caption} chars, ≤ ${PLATFORM_LIMITS[pl].hashtags} hashtags`).join('; ');
  const currency = p.currency ?? ctx.workspace.currency;

  const system = [
    `You write product listings and social captions for small sellers. The seller is in ${market(ctx)}; their buyers are too. Write in ${lang.name}.`,
    lang.guidance,
    p.language === 'en' && ctx.workspace.region === 'ng' ? 'Natural Nigerian register — no slang the seller did not use, no "amazing", no exclamation marks in a row.' : '',
    `Voice: ${voice(p, tone)}. Say what the product does for the buyer before what it is made of. Never invent a feature, material, size or origin that is not visible in the photo or given below — if unsure, leave it out. Never mention that anything was generated.`,
    profile.sells ? `What this seller sells: ${String(profile.sells)}.` : '',
    profile.channels ? `Where they sell: ${String((profile.channels as string[]).join(', '))}.` : '',
    `Prices: quote exactly as given, in ${currency}, never converted. If no price is given, do not mention one.`,
    `Platform limits — hard, not advisory: ${limits}. Hashtags go at the end of each caption, in the caption text as well as in the hashtags object. WhatsApp Status captions end with a one-line call to action to message or order.`,
    'Open each caption differently. Do not start two of them with the same word.',
    'Return only the structure requested.',
  ].filter(Boolean).join('\n');

  const parts: LlmRequest['parts'] = [];
  if (ctx.files.sourceKey) parts.push({ imageUrl: ctx.files.sourceKey.url, mime: ctx.files.sourceKey.mime });
  parts.push({
    text: [
      p.productName ? `Product: ${p.productName}` : 'Product: identify it from the photo',
      p.details ? `Details from the seller: ${p.details}` : '',
      p.price ? `Price: ${p.price}` : '',
      `Platforms wanted: ${platforms.join(', ')}. Leave the other caption fields out.`,
      'Write the listing and captions now.',
    ].filter(Boolean).join('\n'),
  });

  return { system, parts, jsonSchema: COPY_JSON_SCHEMA, maxTokens: 2500, temperature: 0.7 };
}

/** One field, written again: the seller's instruction, the current text, the limit — nothing else changes. */
async function rewriteField(ctx: PipelineContext, p: CapabilityParams<'TEXT_GENERATE'>, profile: Record<string, unknown>, tone: string | null) {
  const field = p.field && COPY_FIELDS[p.field] ? p.field : null;
  if (!field) throw new ProviderError('INVALID_INPUT', `unknown copy field "${p.field}"`, 'copy-pipeline');
  const spec = COPY_FIELDS[field]!;
  const lang = LANGUAGE[p.language] ?? { name: p.language, guidance: '' };
  const platform = field.startsWith('captions.') ? field.slice('captions.'.length) : null;

  const system = [
    `You rewrite one piece of a product listing for a small seller in ${market(ctx)}. Write in ${lang.name}. ${lang.guidance}`,
    `Voice: ${voice(p, tone)}. Never invent a feature that is not in the photo or the seller's notes.`,
    profile.sells ? `What this seller sells: ${String(profile.sells)}.` : '',
    `You are writing the ${spec.label}. Hard limit: ${spec.max} characters.${platform ? ` Platform: ${platform}; keep hashtags at the end, at most ${PLATFORM_LIMITS[platform as keyof typeof PLATFORM_LIMITS]?.hashtags ?? 5}.` : ''}`,
    'Return only the rewritten text in the structure requested — no preamble, no quotes, no options.',
  ].filter(Boolean).join('\n');
  const parts: LlmRequest['parts'] = [];
  if (ctx.files.sourceKey) parts.push({ imageUrl: ctx.files.sourceKey.url, mime: ctx.files.sourceKey.mime });
  parts.push({
    text: [
      p.productName ? `Product: ${p.productName}` : '',
      p.price ? `Price: ${p.price}` : '',
      p.previous ? `What is there now:\n${p.previous}` : '',
      p.instruction ? `What the seller wants different: ${p.instruction}` : 'Write a fresh version that says the same thing a different way.',
    ].filter(Boolean).join('\n\n'),
  });
  const result = await ask(ctx, p, { system, parts, jsonSchema: FIELD_JSON_SCHEMA, maxTokens: 800, temperature: 0.8 }, fieldOutputSchema);
  const value = (result.artifacts[0]!.text as { value: string }).value.trim().slice(0, spec.max);
  return { ...result, artifacts: [{ mime: 'application/json' as const, role: 'text' as const, text: { field, value } }] };
}

function shotPlanRequest(p: CapabilityParams<'TEXT_GENERATE'>, ctx: PipelineContext, profile: Record<string, unknown>, tone: string | null): LlmRequest {
  const system = [
    'You are a director planning a short vertical product ad for social media, to be generated shot by shot by an image-to-video model from ONE reference photo of the product.',
    `Seller in ${market(ctx)}. Voice: ${voice(p, tone)}.`,
    'Rules for shots: 3 or 4 shots; each prompt describes what the camera sees with the product identical to the reference (same shape, colours, label); one clear camera move per shot; no text in the video frame (captions are added later); no people unless the seller asked; realistic lighting; keep every prompt under 60 words.',
    'The first shot is the hook — the product doing the most interesting thing it does. The last shot settles on the product for the end card.',
    profile.sells ? `What this seller sells: ${String(profile.sells)}.` : '',
    'Return only the structure requested.',
  ].filter(Boolean).join('\n');
  const parts: LlmRequest['parts'] = [];
  if (ctx.files.sourceKey) parts.push({ imageUrl: ctx.files.sourceKey.url, mime: ctx.files.sourceKey.mime });
  parts.push({ text: [p.productName ? `Product: ${p.productName}` : '', p.details ? `Details: ${p.details}` : '', p.price ? `Price to show on the end card: ${p.price}` : '', 'Plan the ad.'].filter(Boolean).join('\n') });
  return { system, parts, jsonSchema: SHOT_PLAN_JSON_SCHEMA, maxTokens: 1500, temperature: 0.8 };
}
