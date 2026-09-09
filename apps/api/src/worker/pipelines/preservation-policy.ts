import { PRESERVATION_POLICIES, preservationAcceptance, type PreservationUseCase } from '@anystudio/shared';
import type { PipelineContext } from './index';
import { FIDELITY } from './fidelity';

export async function preservationThresholds(ctx: PipelineContext, useCase: PreservationUseCase) {
  const policy = PRESERVATION_POLICIES.find((p) => p.id === useCase)!;
  const row = await ctx.db.providerModel.findUnique({
    where: { key_capability: { key: policy.key, capability: policy.capability } },
    select: { config: true },
  });
  // Repair/location limits remain strict: lowering acceptance must not paste
  // original pixels onto an unrelated object. Threshold is read once per job.
  return { ...FIDELITY, keep: preservationAcceptance(row?.config, useCase) };
}
