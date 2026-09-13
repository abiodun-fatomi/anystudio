/**
 * Inspect: is this photo the product?
 *
 * A merchant on a marketplace uploads a screenshot, a price list, a picture
 * of nothing in particular. The listing goes live with it and the platform
 * hears about it from a buyer. This is the call that hears first: one vision
 * question, a verdict from a closed list, the reasons from a closed list, and
 * one sentence a merchant can act on.
 *
 * THE MODEL IS SHOWN THE PICTURE AND TOLD WHAT WAS DECLARED
 * ---------------------------------------------------------
 * The platform passes the name and category the merchant typed. The model
 * compares the picture against them, which is the whole trick: "a bag" is
 * only a mismatch if the merchant said "shoes".
 *
 * TWO THINGS THE MODEL IS NOT ASKED
 * ---------------------------------
 * Resolution, because a file's dimensions are a fact we already hold — asking
 * a model to guess them would be paying for a worse answer. It is added here,
 * from the asset row, after the model has spoken.
 *
 * And anyone's age. A person as the subject of a product photo is a problem
 * whoever they are; the code says `person_is_subject` and stops there.
 *
 * VALIDATED, OR REFUNDED
 * ----------------------
 * The answer is parsed against the shared schema. A miss is retried once with
 * the errors quoted back; a second miss fails the generation and the credit
 * comes back. A platform never receives half a verdict.
 */

import {
  INSPECT_JSON_SCHEMA,
  INSPECT_MIN_EDGE_PX,
  ProviderError,
  inspectModelSchema,
  type CapabilityParams,
  type InspectOutput,
  type LlmRequest,
} from '@anystudio/shared';
import type { Pipeline, PipelineContext } from './index';

export const inspectPipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'INSPECT'>;
  const source = ctx.files.sourceKey;
  if (!source) throw new ProviderError('INVALID_INPUT', 'inspect: no source file resolved for sourceKey', 'inspect-pipeline');
  if (!source.mime.startsWith('image/')) throw new ProviderError('INVALID_INPUT', `inspect: the source is ${source.mime}, not an image`, 'inspect-pipeline');

  await ctx.stage('generating', 30, 'looking at the photo');
  const request = inspectRequest(p, source);
  const { verdict, providerKey, providerJobId, costMinor } = await ask(ctx, p, request);

  // Ours to add, not the model's to guess: the file's own dimensions.
  const asset = await ctx.db.mediaAsset.findUnique({ where: { key: p.sourceKey }, select: { width: true, height: true } });
  const edge = Math.max(asset?.width ?? 0, asset?.height ?? 0);
  const issues: InspectOutput['issues'] = [...verdict.issues];
  if (edge > 0 && edge < INSPECT_MIN_EDGE_PX && !issues.includes('low_resolution')) issues.push('low_resolution');

  const out: InspectOutput = {
    ...verdict,
    issues,
    ...(p.declared ? { declared: p.declared } : {}),
  };
  ctx.log.info({ verdict: out.verdict, confidence: out.confidence, issues: out.issues, providerKey }, 'photo inspected');
  return {
    artifacts: [{ mime: 'application/json' as const, role: 'text' as const, text: out }],
    providerKey,
    providerJobId,
    costMinor,
  };
};

function inspectRequest(p: CapabilityParams<'INSPECT'>, source: { url: string; mime: string }): LlmRequest {
  const declared = [p.declared?.name ? `name: "${p.declared.name}"` : '', p.declared?.category ? `category: "${p.declared.category}"` : '']
    .filter(Boolean)
    .join(', ');
  const system = [
    'You check product photos for an online marketplace before they go live. You are given the photo and, when the merchant supplied them, the product name and category they typed.',
    'Decide one of four verdicts.',
    '"product": this is a photograph of a physical product for sale, and it is consistent with whatever was declared.',
    '"mismatch": this is a product photograph, but it clearly is not the declared category or name — shoes declared as a bag, a phone declared as a dress.',
    '"not_a_product": a screenshot, a document or price list, text on a plain background, a person as the main subject, an empty room, a logo — anything that is not a photograph of a product.',
    '"unclear": too dark, too blurred or too small to say what it is.',
    'Be lenient about styling. A bag on a bed under a ceiling light is still a product photograph. A product held in a hand is still a product photograph. Only a person who is themselves the subject is `person_is_subject`.',
    'Be strict about the declaration. When a name or category is given and the picture plainly shows something else, say "mismatch", even if the picture is a fine product photo.',
    'List every issue that applies from the fixed list, and only from that list. Leave it empty when nothing is wrong.',
    'Then write one sentence to the merchant, in plain words, saying what to do instead: "Take a photo of the bag itself on a plain surface" rather than "the image is unsuitable". Never mention AI, models, confidence or this check.',
    'Never guess anyone’s age. Never describe a person beyond "a person".',
    'Answer only in the structure requested.',
  ].join('\n');
  const parts: LlmRequest['parts'] = [
    { imageUrl: source.url, mime: source.mime },
    {
      text: [
        declared ? `The merchant declared — ${declared}.` : 'The merchant declared nothing about this product; judge only whether it is a product photograph.',
        'Inspect the photo now.',
      ].join('\n'),
    },
  ];
  return { system, parts, jsonSchema: INSPECT_JSON_SCHEMA, maxTokens: 400, temperature: 0.1 };
}

/** One call, validated; a miss is retried once with the errors quoted back. */
async function ask(ctx: PipelineContext, p: CapabilityParams<'INSPECT'>, request: LlmRequest) {
  let lastIssues: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const req: LlmRequest = lastIssues
      ? {
          ...request,
          parts: [
            ...request.parts,
            { text: `Your previous answer did not fit the required structure:\n${lastIssues}\nAnswer again, fixing exactly those problems.` },
          ],
        }
      : request;
    const result = await ctx.callCapability(
      'TEXT_GENERATE',
      { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, params: { task: 'inspect', ...p }, files: ctx.files, prompt: req },
      { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail) => void ctx.stage('generating', 55, detail) },
    );
    const text = result.artifacts.find((a) => a.text !== undefined)?.text;
    const parsed = inspectModelSchema.safeParse(text);
    if (parsed.success) return { verdict: parsed.data, providerKey: result.providerKey, providerJobId: result.providerJobId, costMinor: result.costMinor };
    lastIssues = parsed.error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    ctx.log.warn({ attempt, issues: lastIssues, providerKey: result.providerKey }, 'inspect did not fit the schema; asking again with the errors');
  }
  throw new ProviderError('RETRYABLE', `inspect failed schema validation twice: ${lastIssues}`, 'inspect-pipeline');
}
