import type { Capability } from '@anystudio/shared';

/** Research-informed preferences, not benchmark supremacy. Only reorder
 * eligible rows; the router still enforces credentials, enabled flags,
 * workspace restrictions and circuit breakers. Untagged requests retain
 * operator-owned database priorities. See docs/PROVIDER_QUALITY.md.
 */
export function imageQualityPreference(capability: Capability, input: unknown): string[] | undefined {
  const useCase = (input as { useCase?: unknown } | null)?.useCase;
  if (capability === 'IMAGE_GENERATE') {
    if (useCase === 'photography') return ['fal:flux-2-pro', 'vertex:gemini-3-pro-image'];
    if (useCase === 'design') return ['vertex:gemini-3-pro-image', 'fal:flux-2-pro'];
  }
  if (capability === 'IMAGE_EDIT') {
    if (useCase === 'design') return ['vertex:gemini-3-pro-image', 'fal:seedream-4.5-edit', 'bfl:flux-kontext-pro'];
    if (useCase === 'photography') return ['fal:seedream-4.5-edit', 'vertex:gemini-3-pro-image', 'bfl:flux-kontext-pro'];
  }
  return undefined;
}
