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
import { EXPORT_SIZES, ProviderError, judgesShape, type CapabilityParams, type ProviderArtifact, type ProviderResult } from '@anystudio/shared';
import type { Pipeline, PipelineContext } from './index';
import { FIDELITY, fidelity, type FidelityReport } from './fidelity';
import { applyBrand, artifactBytes, pasteProductAt } from './image';
import { focalCrop, sharpnessFocal } from './crop';
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

  const strict = judgesShape(p.mode);

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
    ctx.log.info({ mode: p.mode, pass: attempt, strict, ...report, thresholds: FIDELITY, providerKey: result.providerKey }, 'product shot fidelity measured');

    // A mode that reshapes the product on purpose is measured for the record
    // and shipped regardless. Refusing here would refuse the good ones.
    if (!strict) {
      picked = { bytes, result, report, repaired: false };
      break;
    }

    const found = report.placed && report.structure >= FIDELITY.locate;
    if (report.score >= FIDELITY.keep) {
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
        `product quality check failed after ${attempts} attempts: fidelity ${report.score} (keep ${FIDELITY.keep}); structure ${report.structure} (locate ${FIDELITY.locate})`,
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
