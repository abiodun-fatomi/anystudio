/**
 * Copy: descriptions, captions, hashtags, alt text, SEO — and shot plans.
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
 */

import { ProviderError, copyOutputSchema, COPY_JSON_SCHEMA, shotPlanSchema, SHOT_PLAN_JSON_SCHEMA, PLATFORM_LIMITS, type CapabilityParams, type LlmRequest } from '@anystudio/shared';
import type { Pipeline, PipelineContext } from './index';

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', 'en-NG': 'Nigerian English', pcm: 'Nigerian Pidgin', yo: 'Yoruba', ig: 'Igbo', ha: 'Hausa', fr: 'French', sw: 'Swahili', pt: 'Portuguese', es: 'Spanish', ar: 'Arabic',
};

export const copyPipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'TEXT_GENERATE'>;
  const brand = ctx.brandKit;
  const profile = (ctx.workspace.profile as Record<string, unknown> | null) ?? {};

  const request = p.task === 'shot_plan' ? shotPlanRequest(p, ctx, profile, brand?.tone ?? null) : copyRequest(p, ctx, profile, brand?.tone ?? null);
  const schema = p.task === 'shot_plan' ? shotPlanSchema : copyOutputSchema;

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
      return { artifacts: [{ mime: 'application/json', role: 'text', text: parsed.data }], providerKey: result.providerKey, providerJobId: result.providerJobId, costMinor: result.costMinor };
    }
    lastIssues = parsed.error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    ctx.log.warn({ attempt, issues: lastIssues, providerKey: result.providerKey }, 'copy did not fit the schema; asking again with the errors');
  }
  throw new ProviderError('RETRYABLE', `copy failed schema validation twice: ${lastIssues}`, 'copy-pipeline');
};

function market(ctx: PipelineContext): string {
  return ({ ng: 'Nigeria', gh: 'Ghana', ke: 'Kenya', za: 'South Africa', uk: 'United Kingdom', us: 'United States' } as Record<string, string>)[ctx.workspace.region] ?? ctx.workspace.region;
}

function copyRequest(p: CapabilityParams<'TEXT_GENERATE'>, ctx: PipelineContext, profile: Record<string, unknown>, tone: string | null): LlmRequest {
  const lang = LANGUAGE_NAMES[p.language] ?? p.language;
  const platforms = p.platforms;
  const limits = platforms.map((pl) => `${pl}: caption ≤ ${PLATFORM_LIMITS[pl].caption} chars, ≤ ${PLATFORM_LIMITS[pl].hashtags} hashtags`).join('; ');
  const currency = p.currency ?? ctx.workspace.currency;

  const system = [
    `You write product listings and social captions for small sellers. The seller is in ${market(ctx)}; their buyers are too. Write in ${lang}${p.language === 'en' && ctx.workspace.region === 'ng' ? ' with a natural Nigerian register — no slang the seller did not use, no "amazing", no exclamation marks in a row' : ''}.`,
    `Voice: ${tone ?? p.tone ?? 'warm, direct, confident, never hype'}. Say what the product does for the buyer before what it is made of. Never invent a feature, material, size or origin that is not visible in the photo or given below — if unsure, leave it out. Never mention that anything was generated.`,
    profile.sells ? `What this seller sells: ${String(profile.sells)}.` : '',
    profile.channel ? `Where they sell: ${String(profile.channel)}.` : '',
    `Prices: quote exactly as given, in ${currency}, never converted. If no price is given, do not mention one.`,
    `Platform limits — hard, not advisory: ${limits}. Hashtags go at the end of each caption, in the caption text as well as in the hashtags object. WhatsApp Status captions end with a one-line call to action to message or order.`,
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

function shotPlanRequest(p: CapabilityParams<'TEXT_GENERATE'>, ctx: PipelineContext, profile: Record<string, unknown>, tone: string | null): LlmRequest {
  const system = [
    'You are a director planning a short vertical product ad for social media, to be generated shot by shot by an image-to-video model from ONE reference photo of the product.',
    `Seller in ${market(ctx)}. Voice: ${tone ?? p.tone ?? 'warm, direct, confident'}.`,
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
