/**
 * The voice list is fetched once per workspace and shared by every picker
 * in the studio; Settings forgets it after a voice is recorded or removed
 * so the next picker shows the change.
 */
import type { Voice } from '../api';

export const voicesCache: Record<string, Promise<Voice[]> | undefined> = {};

export function forgetVoices(workspaceId?: string) {
  if (workspaceId) delete voicesCache[workspaceId];
  else for (const k of Object.keys(voicesCache)) delete voicesCache[k];
}
