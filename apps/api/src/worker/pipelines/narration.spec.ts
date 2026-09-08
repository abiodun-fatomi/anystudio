import { describe, expect, it, vi } from 'vitest';
import { capabilityParams } from '@anystudio/shared';
import { renderNarration } from './narration';
import type { PipelineContext } from './index';

vi.mock('./ffmpeg', () => ({ durationOf: vi.fn(async () => 2000) }));

const params = () => capabilityParams.IMAGE_TO_VIDEO.parse({ sourceKey: 'ws/photo.jpg', narration: { script: 'Our bottle is ready.', voiceId: 'voice-1' } });
function fixture(otherWorkspace = false) {
  const callCapability = vi.fn(async () => ({
    providerKey: 'elevenlabs:tts',
    artifacts: [{ role: 'audio', mime: 'audio/mpeg', bytes: Buffer.from('test audio') }],
  }));
  const update = vi.fn();
  const ctx = {
    row: { id: 'gen-1', workspaceId: 'ws', input: params(), createdAt: new Date() },
    signal: new AbortController().signal,
    stage: vi.fn(),
    callCapability,
    db: {
      voiceProfile: {
        findUnique: vi.fn(async () => ({
          active: true,
          kind: 'CLONE',
          workspaceId: otherWorkspace ? 'other' : 'ws',
          providerKey: 'elevenlabs:tts',
          providerVoiceId: 'vendor-voice',
          language: 'en-US',
        })),
      },
      generation: { findUniqueOrThrow: vi.fn(async () => ({ input: params() })), update },
    },
    media: { putGenerationWork: vi.fn(async () => 'ws/narration.mp3') },
  } as unknown as PipelineContext;
  return { ctx, callCapability, update };
}
describe('off-screen product narration', () => {
  it('records with the selected voice owner and persists the clip for assembly retries', async () => {
    const f = fixture();
    expect(await renderNarration(f.ctx, params(), 5000)).toEqual({ key: 'ws/narration.mp3', durationMs: 2000, mime: 'audio/mpeg' });
    expect(f.callCapability).toHaveBeenCalledWith(
      'VOICEOVER',
      expect.objectContaining({ params: expect.objectContaining({ providerVoiceId: 'vendor-voice' }) }),
      expect.objectContaining({ route: { only: 'elevenlabs:tts' } }),
    );
    expect(f.update).toHaveBeenCalledOnce();
  });
  it('reuses a stored narration without another paid call', async () => {
    const f = fixture();
    await renderNarration(f.ctx, { ...params(), narrationClip: { key: 'ws/saved.mp3', durationMs: 2000, mime: 'audio/mpeg' } }, 5000);
    expect(f.callCapability).not.toHaveBeenCalled();
  });
  it('rejects another workspace’s cloned voice', async () => {
    const f = fixture(true);
    await expect(renderNarration(f.ctx, params(), 5000)).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.callCapability).not.toHaveBeenCalled();
  });
  it('does not silently cut off speech that exceeds the video', async () => {
    const f = fixture();
    await expect(renderNarration(f.ctx, params(), 1000)).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.update).not.toHaveBeenCalled();
  });
});
