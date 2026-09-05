/**
 * Lip-sync: new words on the seller's video, mouth moving to match.
 *
 * The words come one of two ways. An audio file they uploaded goes straight
 * to the vendor with the video. A script is recorded first — the voiceover
 * capability, routed to the voice's own vendor exactly as the voice tool
 * does — stored beside the row, and then sent. Either way the deliverable
 * is one video, and the text output says what was said.
 */
import { LIPSYNC_MAX_SEC, ProviderError, type CapabilityParams, type ProviderArtifact, type ProviderFile } from '@anystudio/shared';
import type { Pipeline, PipelineContext } from './index';
import { MediaService } from '../../modules/media/media.service';
import { fetchBytes } from '../../modules/provider/adapters/http';
import { durationOf, extOf, guardLength } from './ffmpeg';

export const lipsyncPipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'LIPSYNC'>;
  ctx.log.info({ hasAudio: Boolean(p.audioKey), hasScript: Boolean(p.script), voiceId: p.voiceId, consent: p.consent }, 'lip-sync requested');

  await guardLength(ctx, 'sourceKey', LIPSYNC_MAX_SEC);
  let files: Record<string, ProviderFile> = { ...ctx.files };
  let audioKey = p.audioKey;
  let recorded: { providerKey: string; providerJobId?: string; costMinor?: number; script: string } | null = null;
  if (!audioKey) {
    if (!p.script?.trim()) throw new ProviderError('INVALID_INPUT', 'a lip-sync needs an audio file or a script', 'lipsync-pipeline');
    await ctx.stage('preparing', 12, 'recording the script');
    const r = await record(ctx, p);
    audioKey = r.audioKey;
    files = { ...files, audioKey: r.file };
    recorded = r;
  }

  await ctx.stage('generating', 30, 'matching the lips');
  const result = await ctx.callProvider(
    { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, capability: 'LIPSYNC', files, params: { ...p, audioKey } },
    {
      timeoutMs: ctx.budgetMs,
      signal: ctx.signal,
      onProgress: (detail, progress) => void ctx.stage('generating', Math.max(30, Math.min(85, progress ?? 50)), detail),
    },
  );
  const video = result.artifacts.find((a) => a.role === 'video');
  if (!video) throw new ProviderError('RETRYABLE', `${result.providerKey} returned no video`, result.providerKey);

  const artifacts: ProviderArtifact[] = [
    video,
    {
      text: { script: recorded?.script ?? null, voice: p.voiceId ?? null, language: p.language, audioKey: p.audioKey ?? null, syncedBy: result.providerKey },
      mime: 'application/json',
      role: 'text',
    },
  ];
  return {
    artifacts,
    providerKey: recorded ? `${recorded.providerKey}+${result.providerKey}` : result.providerKey,
    providerJobId: [recorded?.providerJobId, result.providerJobId].filter(Boolean).join('+') || undefined,
    costMinor: (result.costMinor ?? 0) + (recorded?.costMinor ?? 0),
  };
};

/** Read the script in the chosen voice and store the take beside the row. */
async function record(ctx: PipelineContext, p: CapabilityParams<'LIPSYNC'>) {
  const script = p
    .script!.replace(/[*_#`>]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let providerVoiceId: string | undefined;
  let only: string | undefined;
  let language = p.language;
  if (p.voiceId) {
    const voice = await ctx.db.voiceProfile.findUnique({ where: { key: p.voiceId } });
    if (!voice?.active) throw new ProviderError('INVALID_INPUT', `unknown voice "${p.voiceId}"`, 'lipsync-pipeline');
    providerVoiceId = voice.providerVoiceId;
    only = voice.providerKey;
    if (!p.language || p.language === 'en') language = voice.language.split('-')[0] ?? 'en';
  }
  const params: CapabilityParams<'VOICEOVER'> = { script, language, voiceId: p.voiceId, style: 'natural', speed: 1, providerVoiceId };
  const r = await ctx.callCapability(
    'VOICEOVER',
    { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, params, files: {} },
    { timeoutMs: 120_000, signal: ctx.signal, route: only ? { only } : undefined },
  );
  const take = r.artifacts.find((a) => a.role === 'audio');
  const bytes = take?.bytes ?? (take?.url ? (await fetchBytes(r.providerKey, take.url, 60_000)).bytes : undefined);
  if (!take || !bytes) throw new ProviderError('RETRYABLE', `${r.providerKey} returned no audio for the script`, r.providerKey);
  const ext = extOf(take.mime) === 'bin' ? 'mp3' : extOf(take.mime);
  const audioKey = MediaService.key(ctx.row.workspaceId, `gen/${ctx.row.id}/work`, `voice.${ext}`, ctx.row.createdAt);
  await ctx.media.put(audioKey, bytes, take.mime);
  const durationMs = take.durationMs ?? (await durationOf(bytes, ext));
  ctx.log.info({ audioKey, durationMs, words: script.split(/\s+/).length, providerKey: r.providerKey }, 'script recorded');
  return {
    audioKey,
    file: { url: await ctx.media.signRead(audioKey, 60 * 60), mime: take.mime, bytes: bytes.byteLength } satisfies ProviderFile,
    providerKey: r.providerKey,
    providerJobId: r.providerJobId,
    costMinor: r.costMinor,
    script,
  };
}
