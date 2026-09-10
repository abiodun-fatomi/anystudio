import { describe, expect, it, vi } from 'vitest';
import { PRESERVATION_POLICIES, preservationAcceptance } from '@anystudio/shared';
import { preservationThresholds } from './preservation-policy';
import { FIDELITY } from './fidelity';
import type { PipelineContext } from './index';

describe('per-use-case preservation policy', () => {
  it.each(PRESERVATION_POLICIES)('loads the independent $id threshold', async (policy) => {
    const findUnique = vi.fn(async () => ({ config: { preservationAcceptance: { [policy.id]: 0.5 } } }));
    const ctx = { db: { providerModel: { findUnique } } } as unknown as PipelineContext;
    expect(await preservationThresholds(ctx, policy.id)).toEqual({ ...FIDELITY, keep: 0.5 });
    expect(findUnique).toHaveBeenCalledWith({ where: { key_capability: { key: policy.key, capability: policy.capability } }, select: { config: true } });
  });
  it('does not leak one mode setting into another', () => {
    expect(preservationAcceptance({ preservationAcceptance: { ironing: 0.5 } }, 'expand')).toBe(0.86);
  });
  it.each([null, -1, 0, 1.5, '0.5', NaN])('uses the strict default for corrupt values %s', (value) => {
    expect(preservationAcceptance({ preservationAcceptance: { design: value } }, 'design')).toBe(0.86);
  });
});
