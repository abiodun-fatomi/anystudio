/**
 * The merchant shots, finished rather than merely generated.
 *
 * Every one of these modes was going straight to the vendor and straight back
 * out — one call, one PNG, no check, no price on it, no sizes cut. That is
 * the difference between a demo and a product, and it is the whole of the
 * edge we have: the shot a merchant gets from an image tool is a picture,
 * and the shot they get from here is something they can post.
 *
 * Four things happen to every result before it is theirs:
 *
 *   1. IS IT STILL THEIR PRODUCT? A model handed a photo of a wax-print
 *      dress will sometimes return a different wax-print dress. That is
 *      worthless — worse than worthless, because the seller may not notice
 *      until a customer does. So the product is cut out, and the output is
 *      measured against it.
 *
 *      Whether a bad score can REFUSE depends on the mode, and this is the
 *      part that is easy to get wrong. "Press it" hands back the same
 *      garment in the same pose, so a product that moved or changed colour
 *      is a failure and the check should refuse it. "On a model" hands back
 *      that garment draped on a body — the pixels are SUPPOSED to differ,
 *      and refusing on a low score there would throw away exactly the shots
 *      a merchant came for. Both are measured; only the first can refuse.
 *      (`judgesShape` in shared carries that decision, next to the modes.)
 *
 *   2. THE ANGLES ARE WORTH MORE THAN THE PROMPT. Extra photos of the same
 *      item are the cheapest quality lever there is — a model shown the back
 *      of the bag stops inventing one. The schema already takes them; this
 *      says so in the progress line, because a merchant who learns that adds
 *      them next time and every shot after that is better.
 *
 *   3. THE PRICE AND THE NAME. These go to WhatsApp Status, not to a design
 *      tool. A picture without a price is a conversation the seller has to
 *      have forty times. Composited by us with sharp, never asked of a model
 *      that cannot spell a naira sign.
 *
 *   4. EVERY SIZE, AIMED AT THE PRODUCT. A square for the feed, a 9:16 for
 *      the Status, cropped towards where the product actually is rather than
 *      towards the brightest thing in the frame.
 *
 * Steps 3 and 4 are ours and cost nothing: the same sharp pass the branded
 * image pipeline already does. Step 1 costs one background-removal call, and
 * only on the modes that can use it.
 */

import sharp from 'sharp';
import {
  ASPECTS,
  EXPORT_SIZES,
  ProviderError,
  judgesShape,
  type Aspect,
  type CapabilityParams,
  type ProviderArtifact,
  type ProviderResult,
} from '@anystudio/shared';
import type { Pipeline, PipelineContext } from './index';
import { FIDELITY, fidelity, type FidelityReport } from './fidelity';
import { preservationThresholds, tunedUseCase } from './preservation-policy';
import { applyBrand, artifactBytes, pasteProductAt } from './image';
import { focalCrop, maskFocal, sharpnessFocal } from './crop';
import { fetchBytes } from '../../modules/provider/adapters/http';
import { rethrowIfAborted } from './abort';
import { restylePipeline } from './restyle';

type Params = CapabilityParams<'PRODUCT_SHOT'>;

export const productShotPipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as Params;
  const sourceUrl = ctx.files.sourceKey?.url;
  if (!sourceUrl) throw new ProviderError('INVALID_INPUT', 'no source photo', 'product-shot');
  // Beautify is a whole-photo enhancement, not a studio-scene regeneration.
  // No segmentation means a person cannot be mistaken for background.
  if (p.mode === 'beautify') {
    const enhanced = await restylePipeline({
      ...ctx,
      row: { ...ctx.row, input: { ...p, restyle: 'natural', prompt: 'Enhance the original photo', sizes: [] } },
    });
    await ctx.stage('composing', 76, 'Adding your name and price');
    const branded = await applyBrand(ctx, enhanced.artifacts[0]!.bytes!, p);
    const meta = await sharp(branded).metadata();
    const artifacts: ProviderArtifact[] = [{ bytes: new Uint8Array(branded), mime: 'image/png', role: 'image', width: meta.width, height: meta.height }];
    for (const size of p.sizes) {
      const { width, height } = EXPORT_SIZES[size];
      const bytes = await sharp(branded)
        .resize(width, height, { fit: 'contain', background: '#ffffff' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 95 })
        .toBuffer();
      artifacts.push({ bytes: new Uint8Array(bytes), mime: 'image/jpeg', role: 'variant', width, height, size });
    }
    ctx.log.info({ mode: p.mode, providerKey: 'local:beautify', sizes: p.sizes.length }, 'whole-photo enhancement finished without regenerating the subject');
    return { artifacts, providerKey: 'local:beautify', costMinor: 0 };
  }
  if (p.mode === 'isolate') return productAlone(ctx, p);

  const strict = judgesShape(p.mode);
  // Only a mode the check may refuse has a tunable acceptance; the rest are measured against the fixed defaults, for the record.
  const tuned = strict ? tunedUseCase(p.mode) : null;
  const thresholds = tuned ? await preservationThresholds(ctx, tuned) : FIDELITY;

  // 1. The mask, and the original to measure against.
  //
  // A failure here is not a failure of the shot. If the cutout cannot be made
  // the loop degrades to a single trusted call: better an unmeasured picture
  // than a refused one for a reason the customer cannot act on.
  const { source, cutout } = await productMask(ctx, p);

  if (p.angleKeys.length > 0) await ctx.stage('preparing', 12, `Using your ${p.angleKeys.length + 1} photos of it`);

  // 2. Ask, measure, decide. Twice at most, and the second time only where a
  // refusal would have been fair anyway.
  let picked: { bytes: Uint8Array; result: ProviderResult; report: FidelityReport | null; repaired: boolean } | null = null;
  const attempts = strict && cutout ? 2 : 1;
  for (let attempt = 1; attempt <= attempts && !picked; attempt++) {
    const result = await ctx.callProvider(
      { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, capability: 'PRODUCT_SHOT', params: p, files: ctx.files },
      { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('generating', progress ?? 40, detail) },
    );
    const bytes = await artifactBytes(result, ctx.signal);

    if (!source || !cutout) {
      picked = { bytes, result, report: null, repaired: false };
      break;
    }

    await ctx.stage('composing', 62, 'Checking it is still your product');
    const report = await fidelity(source, cutout, bytes, { expandedCanvas: p.mode === 'expand' });
    ctx.log.info({ mode: p.mode, pass: attempt, strict, ...report, thresholds, providerKey: result.providerKey }, 'product shot fidelity measured');

    // A mode that reshapes the product on purpose is measured for the record
    // and shipped regardless. Refusing here would refuse the good ones.
    if (!strict) {
      picked = { bytes, result, report, repaired: false };
      break;
    }

    const found = report.placed && report.structure >= FIDELITY.locate;
    if (report.score >= thresholds.keep) {
      picked = { bytes, result, report, repaired: false };
    } else if (found && (report.score >= FIDELITY.composite || attempt === attempts)) {
      // Close but drifting: the seller's own pixels go back where the model
      // put the product, so they keep the new light and their real label.
      picked = { bytes: await pasteProductAt(bytes, cutout, report.placed!), result, report, repaired: true };
      ctx.log.warn({ mode: p.mode, pass: attempt, score: report.score, placed: report.placed }, 'product drifted; original pixels put back where it was found');
    } else if (attempt < attempts) {
      ctx.log.warn({ mode: p.mode, pass: attempt, score: report.score }, 'product not kept; asking once more');
      await ctx.stage('generating', 30, 'That one changed your product — trying again');
    } else {
      throw new ProviderError(
        'LOW_QUALITY',
        `product quality check failed after ${attempts} attempts: fidelity ${report.score} (keep ${thresholds.keep}); structure ${report.structure} (locate ${FIDELITY.locate})`,
        result.providerKey,
        {
          providerJobId: result.providerJobId,
          raw: report,
        },
      );
    }
  }
  if (!picked) throw new ProviderError('RETRYABLE', 'no image produced', 'product-shot');

  // 3. Their price, their name, our watermark.
  await ctx.stage('composing', 76, 'Adding your name and price');
  const branded = await applyBrand(ctx, picked.bytes, p);

  // 4. Every size, aimed at the product rather than at the window behind it.
  await ctx.stage('composing', 88, 'Cutting every size');
  const meta = await sharp(branded).metadata();
  const artifacts: ProviderArtifact[] = [{ bytes: new Uint8Array(branded), mime: 'image/png', role: 'image', width: meta.width, height: meta.height }];
  const focal = (picked.report?.placed ? { ...picked.report.placed, from: 'match' as const } : null) ?? (await sharpnessFocal(branded));
  for (const size of p.sizes) {
    const spec = EXPORT_SIZES[size];
    const bytes = await focalCrop(branded, spec.width, spec.height, focal);
    artifacts.push({ bytes: new Uint8Array(bytes), mime: 'image/jpeg', role: 'variant', width: spec.width, height: spec.height, size });
  }
  ctx.log.info({ mode: p.mode, score: picked.report?.score ?? null, repaired: picked.repaired, sizes: p.sizes.length }, 'product shot finished');
  return { artifacts, providerKey: picked.result.providerKey, providerJobId: picked.result.providerJobId, costMinor: picked.result.costMinor };
};

/**
 * Product alone: whatever was holding, hanging or surrounding the product
 * taken out, the product itself untouched.
 *
 * This is deliberately NOT a described edit sent to the product-shot vendor.
 * Asked to "remove the hand" on a phone, that vendor drew a different phone
 * — same brand, another colour, another camera — and the ordinary check
 * could not have caught it, because the ordinary check measures against the
 * photo's own cutout, and the cutout of a phone in a hand is the phone AND
 * the hand: the result that did as asked and the result that invented a
 * phone both score as "product changed".
 *
 * So the work goes to the image-edit route, the models that hold a subject
 * still while its surroundings change, and the check is turned round. The
 * RESULT is cut out — by then it is the product alone — and that product is
 * looked for in the ORIGINAL photo. Found there with the same structure and
 * colour, it is the seller's product and the picture ships. Not found, the
 * model invented one: a different model is asked once, sternly, and a second
 * miss is refused and refunded rather than posted.
 */
async function productAlone(ctx: PipelineContext, p: Params) {
  await ctx.stage('preparing', 8, 'Reading your photo');
  const source = (await fetchBytes('product-shot', ctx.files.sourceKey!.url, 60_000, ctx.signal)).bytes;
  const meta = await sharp(source).metadata();
  const upright = meta.orientation && meta.orientation >= 5 ? { w: meta.height ?? 1, h: meta.width ?? 1 } : { w: meta.width ?? 1, h: meta.height ?? 1 };
  const aspect = nearestAspect(upright.w / upright.h);

  // Who is asked. The image-edit route first, and on a miss the same route
  // minus the model that missed. When that route has nobody at all — no
  // image-edit key on this deployment — the product-shot vendor's own
  // free-form edit is asked instead, under the same check: it is the vendor
  // that drew the wrong phone, so its answer is trusted exactly as far as
  // the check says and not an inch further.
  const exclude: string[] = [];
  let viaVendor = false;
  let picked: { bytes: Uint8Array; cut: Uint8Array | null; result: ProviderResult; report: FidelityReport | null } | null = null;
  let last: FidelityReport | null = null;
  let attempt = 0;
  while (attempt < 2 && !picked) {
    attempt++;
    await ctx.stage(
      'generating',
      attempt === 1 ? 20 : 30,
      attempt === 1 ? 'Taking out what is holding it' : 'That one changed your product — asking another model',
    );
    let result: ProviderResult;
    try {
      result = viaVendor ? await vendorEdit(ctx, p, attempt) : await routeEdit(ctx, p, aspect, attempt, exclude);
    } catch (err) {
      rethrowIfAborted(ctx.signal, err);
      if (viaVendor || !(err instanceof ProviderError) || err.kind !== 'PROVIDER_DOWN') throw err;
      ctx.log.warn({ err: err.message }, 'no image-edit provider for product-alone; asking the product-shot vendor under the same check');
      viaVendor = true;
      attempt--;
      continue;
    }
    const bytes = await artifactBytes(result, ctx.signal);

    // The check needs the result's product on its own. If the cutout cannot
    // be made, the picture ships unchecked — as every shot does when the
    // helper call is down — rather than a credit being spent on our plumbing.
    await ctx.stage('composing', 60, 'Checking it is still your product');
    const cut = await resultCutout(ctx, bytes, attempt);
    if (!cut) {
      picked = { bytes, cut: null, result, report: null };
      break;
    }
    const report = await fidelity(bytes, cut, source, { occluded: ALONE.occluded });
    ctx.log.info(
      { mode: p.mode, pass: attempt, ...report, keep: FIDELITY.keep, occluded: ALONE.occluded, providerKey: result.providerKey },
      'product-alone fidelity measured (result located in the original)',
    );
    if (report.placed && report.structure >= FIDELITY.locate && report.score >= FIDELITY.keep) {
      picked = { bytes, cut, result, report };
      break;
    }
    last = report;
    exclude.push(result.providerKey);
    ctx.log.warn(
      { mode: p.mode, pass: attempt, score: report.score, structure: report.structure, providerKey: result.providerKey },
      'product-alone result is not the photographed product',
    );
  }
  if (!picked) {
    throw new ProviderError(
      'LOW_QUALITY',
      `product alone: the edited product was not the photographed one after 2 attempts: fidelity ${last?.score ?? 0} (keep ${FIDELITY.keep}); structure ${last?.structure ?? 0} (locate ${FIDELITY.locate})`,
      'product-alone',
      { raw: last },
    );
  }

  await ctx.stage('composing', 76, 'Adding your name and price');
  const branded = await applyBrand(ctx, picked.bytes, p);
  await ctx.stage('composing', 88, 'Cutting every size');
  const out = await sharp(branded).metadata();
  const artifacts: ProviderArtifact[] = [{ bytes: new Uint8Array(branded), mime: 'image/png', role: 'image', width: out.width, height: out.height }];
  // The crops aim at the product where it sits in the RESULT — the cutout knows — not where it sat in the photo.
  const focal = (picked.cut ? await maskFocal(picked.cut) : null) ?? (await sharpnessFocal(branded));
  for (const size of p.sizes) {
    const spec = EXPORT_SIZES[size];
    const bytes = await focalCrop(branded, spec.width, spec.height, focal);
    artifacts.push({ bytes: new Uint8Array(bytes), mime: 'image/jpeg', role: 'variant', width: spec.width, height: spec.height, size });
  }
  ctx.log.info({ mode: p.mode, score: picked.report?.score ?? null, providerKey: picked.result.providerKey, sizes: p.sizes.length }, 'product alone finished');
  return { artifacts, providerKey: picked.result.providerKey, providerJobId: picked.result.providerJobId, costMinor: picked.result.costMinor };
}

/**
 * How much of the product may be hidden in the PHOTO without counting
 * against the result: the region where the product is found there also
 * holds the fingers or hanger that were over it. A fifth. A hand wrapped
 * round more than that gets a good result refused — the safe way round —
 * and a product redrawn in another colour disagrees everywhere, so leaving
 * a fifth out never rescues it (0.56 on the fixture against a keep of 0.86).
 * The bar itself is the ordinary one; nothing here is lowered.
 */
export const ALONE = { occluded: 0.2 } as const;

/** The image-edit route: the models that hold a subject still while its surroundings change. */
function routeEdit(ctx: PipelineContext, p: Params, aspect: Aspect, attempt: number, exclude: string[]): Promise<ProviderResult> {
  return ctx.callCapability(
    'IMAGE_EDIT',
    {
      generationId: ctx.row.id,
      workspaceId: ctx.row.workspaceId,
      params: { sourceKey: p.sourceKey, prompt: aloneInstruction(p, attempt), preserveProduct: true, useCase: 'photography', aspect, sizes: [] },
      files: ctx.files,
    },
    {
      timeoutMs: ctx.budgetMs,
      signal: ctx.signal,
      onProgress: (detail, progress) => void ctx.stage('generating', progress ?? 40, detail),
      ...(exclude.length ? { route: { exclude } } : {}),
    },
  );
}

/** The product-shot vendor's free-form edit, for a deployment with no image-edit key. Checked like any other answer. */
function vendorEdit(ctx: PipelineContext, p: Params, attempt: number): Promise<ProviderResult> {
  return ctx.callProvider(
    {
      generationId: ctx.row.id,
      workspaceId: ctx.row.workspaceId,
      capability: 'PRODUCT_SHOT',
      params: { ...p, mode: 'edit', prompt: aloneInstruction(p, attempt), sizes: [] },
      files: ctx.files,
    },
    { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('generating', progress ?? 40, detail) },
  );
}

const SHADOW_WORDS: Record<Params['shadow'], string> = {
  soft: ' with a soft, natural contact shadow beneath it',
  hard: ' with a crisp contact shadow beneath it',
  floating: ' with a soft shadow below it, as if floating',
  none: ' and no shadow',
};

function aloneInstruction(p: Params, attempt: number): string {
  const steer = p.prompt?.trim();
  const base =
    `Remove the hand, person, hanger, stand or any prop that is holding, wearing or surrounding the product${steer ? ` (${steer})` : ''}. ` +
    `Show the product alone, complete and exactly as photographed — the same angle, size, colours, materials, text, logos and every detail unchanged — ` +
    `on a plain, seamless, evenly lit light studio background${SHADOW_WORDS[p.shadow]}.`;
  return attempt === 1
    ? base
    : `${base}

IMPORTANT: the previous attempt drew a different product. Reproduce the product pixel-for-pixel from the photo; do not redesign, recolour, reshape or replace it. Only what surrounds it may change.`;
}

/** The result with its background gone — the product alone, for the check. Null when the helper is down. */
async function resultCutout(ctx: PipelineContext, bytes: Uint8Array, attempt: number): Promise<Uint8Array | null> {
  try {
    const key = await ctx.media.putGenerationWork({
      workspaceId: ctx.row.workspaceId,
      generationId: ctx.row.id,
      createdAt: ctx.row.createdAt,
      name: `alone-${attempt}.png`,
      bytes,
      mime: 'image/png',
    });
    const cut = await ctx.callCapability(
      'BACKGROUND_REMOVE',
      {
        generationId: ctx.row.id,
        workspaceId: ctx.row.workspaceId,
        params: { sourceKey: key, background: 'transparent' },
        files: { sourceKey: { key, url: await ctx.media.signRead(key, 60 * 60), mime: 'image/png', bytes: bytes.length } },
      },
      { timeoutMs: 60_000, signal: ctx.signal },
    );
    return await artifactBytes(cut, ctx.signal);
  } catch (err) {
    rethrowIfAborted(ctx.signal, err);
    ctx.log.warn({ err: err instanceof Error ? err.message : err }, 'cutout of the result unavailable; shipping the product-alone shot unchecked');
    return null;
  }
}

/** The catalogue aspect closest to the photo's own, so the product is not re-framed on the way. */
export function nearestAspect(ratio: number): Aspect {
  const value = (a: Aspect) => {
    const [w, h] = a.split(':').map(Number) as [number, number];
    return w / h;
  };
  return [...ASPECTS].sort((a, b) => Math.abs(Math.log(value(a) / ratio)) - Math.abs(Math.log(value(b) / ratio)))[0]!;
}

/**
 * The original and its alpha mask, or nothing.
 *
 * Nothing is a perfectly good answer: the shot still gets made, it just does
 * not get checked. The alternative — failing a generation because a helper
 * call failed — spends a merchant's credits on our plumbing.
 */
async function productMask(ctx: PipelineContext, p: Params): Promise<{ source: Uint8Array | null; cutout: Uint8Array | null }> {
  await ctx.stage('preparing', 8, 'Reading your photo');
  try {
    const source = (await fetchBytes('product-shot', ctx.files.sourceKey!.url, 60_000, ctx.signal)).bytes;
    const cut = await ctx.callCapability(
      'BACKGROUND_REMOVE',
      { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, params: { sourceKey: p.sourceKey, background: 'transparent' }, files: ctx.files },
      { timeoutMs: 60_000, signal: ctx.signal },
    );
    return { source, cutout: await artifactBytes(cut, ctx.signal) };
  } catch (err) {
    rethrowIfAborted(ctx.signal, err);
    ctx.log.warn({ err: err instanceof Error ? err.message : err }, 'cutout unavailable; making this shot without the fidelity check');
    return { source: null, cutout: null };
  }
}
