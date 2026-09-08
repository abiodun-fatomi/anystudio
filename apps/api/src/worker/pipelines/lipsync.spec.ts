import { describe, expect, it } from 'vitest';
import { canUseScriptVoice } from './lipsync';

describe('scripted lip-sync voice ownership', () => {
  it('rejects another workspace cloned voice', () => {
    expect(canUseScriptVoice({ active: true, kind: 'CLONE', workspaceId: 'workspace-b' }, 'workspace-a')).toBe(false);
  });

  it('allows the owning workspace clone and global catalogue voices', () => {
    expect(canUseScriptVoice({ active: true, kind: 'CLONE', workspaceId: 'workspace-a' }, 'workspace-a')).toBe(true);
    expect(canUseScriptVoice({ active: true, kind: 'PRESET', workspaceId: null }, 'workspace-a')).toBe(true);
  });
});
