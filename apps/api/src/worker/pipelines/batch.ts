/**
 * The same thing, to all of them.
 *
 * A merchant does not have one photo. They have the morning's shooting — a
 * rail of dresses, a table of bags, forty items to get online before the
 * afternoon. Doing that one photo at a time is not a smaller version of the
 * job; it is the reason a catalogue gets abandoned halfway through.
 *
 * A batch is a PARENT holding the money and one CHILD per photo doing the
 * work. It is the ad's machinery without the stitch at the end: dispatch,
 * step aside, and when every child is terminal, gather what came back.
 *
 * WHAT MAKES IT SAFE
 *
 *   The children are ORDINARY jobs on the ordinary queues, so forty photos
 *   are forty normal generations. Nothing downstream is special-cased and a
 *   big batch cannot starve a small one — it queues behind itself.
 *
 *   The settings are validated ONCE, against the child capability's own
 *   schema, before a credit moves. A folder of forty with one bad setting
 *   fails free rather than forty times.
 *
 *   A batch is never all-or-nothing. Three failures out of forty leaves the
 *   merchant thirty-seven pictures and a refund of exactly three photos'
 *   worth. Refusing the lot would throw away good work they have waited for.
 */

import { ProviderError, type CapabilityParams, type GenerationOutput } from '@anystudio/shared';
import type { Pipeline, PipelineContext } from './index';

type BatchParams = CapabilityParams<'BATCH'>;

export const batchPipeline: Pipeline = async (ctx) => (ctx.resume ? gather(ctx) : dispatch(ctx));

/** First run: one child per photo, then step aside holding no worker. */
async function dispatch(ctx: PipelineContext): Promise<ReturnType<Pipeline>> {
  const p = ctx.row.input as BatchParams;
  const parent = await ctx.db.generation.findUniqueOrThrow({ where: { id: ctx.row.id } });
  await ctx.stage('routing', 12, `starting ${p.sourceKeys.length} photos`);

  for (const [i, sourceKey] of p.sourceKeys.entries()) {
    await ctx.generations.createChild(parent, p.of, { ...p.params, sourceKey }, i);
  }

  ctx.log.info({ of: p.of, photos: p.sourceKeys.length, credits: ctx.row.credits }, 'batch dispatched');
  return { artifacts: [], waiting: true };
}

/** Second run: every child is terminal. Keep what worked, pay back what did not. */
async function gather(ctx: PipelineContext): Promise<ReturnType<Pipeline>> {
  const p = ctx.row.input as BatchParams;
  const children = await ctx.db.generation.findMany({ where: { parentId: ctx.row.id }, orderBy: { createdAt: 'asc' } });
  const done = children.filter((c) => c.status === 'SUCCEEDED');
  const failed = children.filter((c) => c.status !== 'SUCCEEDED');

  // Not one photo worked: this is a failure, and the runner refunds the lot.
  if (done.length === 0) {
    const first = failed[0];
    throw new ProviderError(
      'RETRYABLE',
      first?.failureReason ? `none of the ${children.length} photos worked: ${first.failureReason}` : `none of the ${children.length} photos worked`,
      'batch',
    );
  }

  // The children already stored their own files. The parent describes them
  // rather than copying: one picture, one object, however many rows point at it.
  const outputs: GenerationOutput[] = [];
  for (const child of done) {
    for (const o of (child.outputs as GenerationOutput[] | null) ?? []) {
      // Only the finished pictures, not every intermediate size, or a batch of
      // forty would hand back two hundred files nobody asked for.
      if (o.role === 'image' || o.role === 'video') outputs.push(o);
    }
  }

  if (failed.length > 0) {
    const share = (ctx.row.credits * failed.length) / children.length;
    await ctx.generations.refundShare(ctx.row, share, `${failed.length} of ${children.length} photos did not work`);
    ctx.log.warn({ failed: failed.length, of: children.length, reasons: failed.slice(0, 3).map((f) => f.failureReason) }, 'part of a batch failed');
  }

  await ctx.stage('storing', 92, `${done.length} of ${children.length} done`);
  ctx.log.info({ of: p.of, done: done.length, failed: failed.length, outputs: outputs.length }, 'batch gathered');
  return { artifacts: [], extraOutputs: outputs };
}
