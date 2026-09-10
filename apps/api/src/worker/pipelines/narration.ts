import { ProviderError, type CapabilityParams } from '@anystudio/shared';
import type { PipelineContext } from './index';
import { durationOf } from './ffmpeg';
import { fetchBytes } from '../../modules/provider/adapters/http';

export async function renderNarration(ctx: PipelineContext, p: CapabilityParams<'IMAGE_TO_VIDEO'>, targetMs: number) {
  if (!p.narration) return undefined;
  if (p.narrationClip) return p.narrationClip;
  const voice = await ctx.db.voiceProfile.findUnique({ where: { key: p.narration.voiceId } });
  if (!voice?.active || (voice.kind === 'CLONE' && voice.workspaceId !== ctx.row.workspaceId))
    throw new ProviderError('INVALID_INPUT', 'Choose an active voice available to this workspace.', 'narration');
  await ctx.stage('composing', 65, 'recording the product narration');
  const result = await ctx.callCapability(
    'VOICEOVER',
    {
      generationId: ctx.row.id,
      workspaceId: ctx.row.workspaceId,
      files: {},
      params: {
        script: p.narration.script,
        voiceId: p.narration.voiceId,
        providerVoiceId: voice.providerVoiceId,
        language: voice.language.split('-')[0],
        style: 'natural',
        speed: 1,
      },
    },
    { timeoutMs: 180_000, signal: ctx.signal, route: { only: voice.providerKey } },
  );
  const artifact = result.artifacts.find((a) => a.role === 'audio');
  const bytes = artifact?.bytes ?? (artifact?.url ? (await fetchBytes(result.providerKey, artifact.url, 60_000, ctx.signal)).bytes : undefined);
  if (!bytes) throw new ProviderError('RETRYABLE', 'The narration provider returned no audio.', result.providerKey);
  const mime = artifact?.mime ?? 'audio/mpeg';
  const ext = mime === 'audio/wav' ? 'wav' : 'mp3';
  const durationMs = await durationOf(bytes, ext);
  if (durationMs > targetMs)
    throw new ProviderError('INVALID_INPUT', 'The spoken narration is longer than the video. Shorten the script or choose a longer video.', 'narration');
  const key = await ctx.media.putGenerationWork({
    workspaceId: ctx.row.workspaceId,
    generationId: ctx.row.id,
    createdAt: ctx.row.createdAt,
    name: `narration.${ext}`,
    bytes,
    mime,
    durationMs,
  });
  const clip = { key, durationMs, mime };
  const fresh = await ctx.db.generation.findUniqueOrThrow({ where: { id: ctx.row.id } });
  await ctx.db.generation.update({ where: { id: ctx.row.id }, data: { input: { ...(fresh.input as object), narrationClip: clip } } });
  return clip;
}
