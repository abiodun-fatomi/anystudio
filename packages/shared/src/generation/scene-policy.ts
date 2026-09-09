/** Operator-owned New Scene policy, stored alongside provider configuration. */
export const SCENE_ACCEPTANCE_DEFAULT = 0.5;
export const SCENE_PROVIDERS = [
  { key: 'fal:flux-2-pro-edit', capability: 'IMAGE_EDIT', priority: 10 },
  { key: 'vertex:gemini-3-pro-image', capability: 'IMAGE_EDIT', priority: 20 },
  { key: 'photoroom:edit', capability: 'BACKGROUND_REPLACE', priority: 30 },
] as const;
export function sceneConfig(value: unknown): { scenePriority?: number; sceneAcceptance?: number } {
  const c = value as Record<string, unknown> | null;
  return {
    ...(typeof c?.scenePriority === 'number' && Number.isInteger(c.scenePriority) && c.scenePriority >= 1 && c.scenePriority <= 1000
      ? { scenePriority: c.scenePriority }
      : {}),
    ...(typeof c?.sceneAcceptance === 'number' && Number.isFinite(c.sceneAcceptance) && c.sceneAcceptance >= 0.1 && c.sceneAcceptance <= 1
      ? { sceneAcceptance: c.sceneAcceptance }
      : {}),
  };
}
