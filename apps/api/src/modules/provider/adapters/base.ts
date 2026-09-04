/**
 * What every adapter shares: the key, the capability list, and the two small
 * helpers that keep vendor code honest — a typed params accessor and a
 * cost estimate that reads the row's config rather than inventing numbers.
 */

import type { Capability, CapabilityParams, CostEstimate, GenerationProvider, ProviderInput, ProviderOpts, ProviderResult } from '@anystudio/shared';
import { ProviderError } from '@anystudio/shared';

/** Rough wall-clock per capability so the studio can set expectations. */
export const EXPECTED_MS: Record<Capability, number> = {
  IMAGE_GENERATE: 15_000,
  IMAGE_EDIT: 20_000,
  BACKGROUND_REMOVE: 5_000,
  BACKGROUND_REPLACE: 15_000,
  RELIGHT: 10_000,
  UPSCALE: 15_000,
  IMAGE_TO_VIDEO: 150_000,
  VIDEO_STITCH: 30_000,
  TEXT_GENERATE: 6_000,
  VOICEOVER: 10_000,
  MUSIC: 120_000,
  DUB: 240_000,
  LIPSYNC: 240_000,
};

export abstract class BaseProvider implements GenerationProvider {
  constructor(
    readonly key: string,
    readonly capabilities: readonly Capability[],
  ) {}

  supports(capability: Capability): boolean {
    return this.capabilities.includes(capability);
  }

  estimateCost(input: ProviderInput): CostEstimate {
    const configured = Number(input.config.costMinor);
    return { costMinor: Number.isFinite(configured) ? configured : 0, expectedMs: EXPECTED_MS[input.capability] };
  }

  abstract generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult>;

  /** The params, typed for the capability the adapter is serving. */
  protected params<C extends Capability>(input: ProviderInput, _capability: C): CapabilityParams<C> {
    return input.params as CapabilityParams<C>;
  }

  /** The signed URL for a param that names a stored file, or a clear error. */
  protected file(input: ProviderInput, name: string): string {
    const f = input.files[name];
    if (!f) throw new ProviderError('INVALID_INPUT', `${this.key}: missing input file "${name}"`, this.key);
    return f.url;
  }

  protected str(config: Record<string, unknown>, name: string, fallback: string): string {
    const v = config[name];
    return typeof v === 'string' && v ? v : fallback;
  }

  protected unsupported(capability: Capability): never {
    throw new ProviderError('INVALID_INPUT', `${this.key}: routed for ${capability}, which it does not implement`, this.key);
  }
}
