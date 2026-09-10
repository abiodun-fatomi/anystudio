import sharp from 'sharp';
import { ProviderError, type CapabilityParams, type ProviderArtifact } from '@anystudio/shared';
import { artifactBytes } from './image';
import type { Pipeline } from './index';

/**
 * Cut the product out, then guarantee the ground it lands on.
 *
 * This ran on `passthrough` — one provider call, artifacts returned untouched —
 * which quietly made the background colour each vendor's private business.
 * Photoroom sets `background.color` and Replicate sets `background_color`, so
 * both honoured it. `fal-ai/bria/background/remove` has no such parameter at
 * all: it removes a background, full stop. An ORGANIZATION workspace routes to
 * `fal:bria-rmbg-2` first (priority 5, and organization-only), so an
 * organization tapping "Plain white" got a transparent PNG and nothing
 * downstream flattened it.
 *
 * Patching the fal adapter would have fixed that one workspace type and left
 * the shape of the bug in place: three vendors each independently responsible
 * for the same promise, and a silent failure the next time one is added or a
 * failover swaps which one answered. So the promise moves here, where it is
 * made once.
 *
 * `flatten` on an image that has no alpha is a no-op, which is what makes this
 * safe to apply to every vendor rather than only the one that needs it —
 * Photoroom's already-painted result passes through untouched. And it makes
 * the cut path the one part of the studio that is genuinely repeatable: the
 * matting model still decides the edge, but the colour behind it is ours, and
 * it is the same colour whichever vendor answered.
 */
export const backgroundRemovePipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'BACKGROUND_REMOVE'>;
  const result = await ctx.callProvider(
    {
      generationId: ctx.row.id,
      workspaceId: ctx.row.workspaceId,
      capability: 'BACKGROUND_REMOVE',
      params: p,
      files: ctx.files,
    },
    { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('generating', progress ?? 40, detail) },
  );

  // "No background" is the one case with nothing to paint, and the case where
  // painting anything would destroy the whole point of the cut-out.
  if (p.background === 'transparent') {
    return { artifacts: result.artifacts, providerKey: result.providerKey, providerJobId: result.providerJobId, costMinor: result.costMinor };
  }

  await ctx.stage('composing', 70, 'Placing it on your background');
  const cut = await artifactBytes(result, ctx.signal);
  const { data, info } = await sharp(cut)
    .flatten({ background: p.background })
    .png()
    .toBuffer({ resolveWithObject: true })
    .catch((err: unknown) => {
      // The vendor was paid and the cut-out exists; only the paint failed. That
      // is a bug in us, not a reason to charge for nothing, so it fails loudly
      // and the runner refunds rather than shipping a transparent PNG to
      // somebody who asked for white.
      throw new ProviderError('RETRYABLE', `could not paint the background: ${err instanceof Error ? err.message : 'unknown'}`, result.providerKey);
    });

  const artifacts: ProviderArtifact[] = [
    { bytes: new Uint8Array(data), mime: 'image/png', role: 'image', width: info.width, height: info.height },
    // Anything the vendor sent beyond the cut-out itself — a mask, a preview —
    // is kept as it was. Only the picture the seller receives is repainted.
    ...result.artifacts.filter((a) => a.role !== 'image').slice(0, 8),
  ];
  return { artifacts, providerKey: result.providerKey, providerJobId: result.providerJobId, costMinor: result.costMinor };
};
