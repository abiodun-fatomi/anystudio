/**
 * A dub: the seller's video, spoken again in another language in the same
 * voice — and, when asked, with the mouth moving to match.
 *
 *   1. DUB. The runner has already narrowed the vendors to the ones that
 *      speak the target language, HeyGen first when lips are wanted because
 *      it does both in one pass. ElevenLabs dubs the sound only.
 *   2. LIPS, if still owed. When the dubbing vendor left the lips alone
 *      (`meta.lipsync !== true`) and the seller asked for them, the dubbed
 *      video is stored, its new soundtrack pulled out with ffmpeg, and both
 *      go to a LIPSYNC vendor. What comes back is the deliverable.
 *
 * The text output records what was done — the language, whether the lips
 * were moved, which vendor spoke — so the card and the library can say it,
 * and support can see it without reading the worker's logs.
 */
import { DUB_MAX_SEC, ProviderError, dubLanguage, type CapabilityParams, type ProviderArtifact } from '@anystudio/shared';
import type { Pipeline, PipelineContext } from './index';
import { MediaService } from '../../modules/media/media.service';
import { fetchBytes } from '../../modules/provider/adapters/http';
import { extractAudio, extOf, guardLength } from './ffmpeg';

export const dubPipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'DUB'>;
  const language = dubLanguage(p.targetLanguage);
  if (!language) throw new ProviderError('INVALID_INPUT', `"${p.targetLanguage}" is not a language we can dub into`, 'dub-pipeline');
  ctx.log.info(
    { targetLanguage: p.targetLanguage, sourceLanguage: p.sourceLanguage, lipsync: p.lipsync, speakers: p.speakers, consent: p.consent },
    'dub requested',
  );

  await guardLength(ctx, 'sourceKey', DUB_MAX_SEC);
  await ctx.stage('generating', 15, `dubbing into ${language.name}`);
  const dubbed = await ctx.callProvider(
    { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, capability: 'DUB', files: ctx.files, params: p },
    {
      timeoutMs: ctx.budgetMs,
      signal: ctx.signal,
      onProgress: (detail, progress) => void ctx.stage('generating', Math.max(15, Math.min(70, progress ?? 40)), detail),
    },
  );
  const video = dubbed.artifacts.find((a) => a.role === 'video');
  if (!video) throw new ProviderError('RETRYABLE', `${dubbed.providerKey} returned no video`, dubbed.providerKey);
  const lipsDone = dubbed.meta?.lipsync === true;

  let artifacts: ProviderArtifact[] = [video];
  let providerKey = dubbed.providerKey;
  let providerJobId = dubbed.providerJobId;
  let costMinor = dubbed.costMinor ?? 0;
  let lipsync = lipsDone;

  if (p.lipsync && !lipsDone) {
    await ctx.stage('composing', 72, 'matching the lips to the new voice');
    const synced = await syncLips(ctx, video, p.quality, dubbed.providerKey);
    artifacts = [synced.video];
    providerKey = `${dubbed.providerKey}+${synced.providerKey}`;
    providerJobId = [dubbed.providerJobId, synced.providerJobId].filter(Boolean).join('+') || undefined;
    costMinor += synced.costMinor ?? 0;
    lipsync = true;
  }

  artifacts.push({
    text: {
      targetLanguage: p.targetLanguage,
      language: language.name,
      sourceLanguage: p.sourceLanguage,
      lipsync,
      dubbedBy: dubbed.providerKey,
      keepBackground: p.keepBackground,
    },
    mime: 'application/json',
    role: 'text',
  });
  return { artifacts, providerKey, providerJobId, costMinor };
};

/** Store the dubbed video, pull its soundtrack, and send both to a lip-sync vendor. */
async function syncLips(ctx: PipelineContext, video: ProviderArtifact, quality: 'speed' | 'precision', dubbedBy: string) {
  const bytes = video.bytes ?? (video.url ? (await fetchBytes(dubbedBy, video.url, 300_000)).bytes : undefined);
  if (!bytes) throw new ProviderError('RETRYABLE', `${dubbedBy} returned a video with no bytes`, dubbedBy);
  const ext = extOf(video.mime) === 'bin' ? 'mp4' : extOf(video.mime);
  const { audio, durationMs } = await extractAudio(bytes, ext);

  // Intermediates live beside the outputs; they are not outputs (never recorded on the row), and a later sweep may drop them.
  const scope = `gen/${ctx.row.id}/work`;
  const videoKey = MediaService.key(ctx.row.workspaceId, scope, `dubbed.${ext}`, ctx.row.createdAt);
  const audioKey = MediaService.key(ctx.row.workspaceId, scope, 'dubbed.mp3', ctx.row.createdAt);
  await Promise.all([ctx.media.put(videoKey, bytes, video.mime || 'video/mp4'), ctx.media.put(audioKey, audio, 'audio/mpeg')]);
  const [videoUrl, audioUrl] = await Promise.all([ctx.media.signRead(videoKey, 60 * 60), ctx.media.signRead(audioKey, 60 * 60)]);
  ctx.log.info({ videoKey, audioKey, durationMs }, 'dubbed video stored; asking a lip-sync vendor');

  const params: CapabilityParams<'LIPSYNC'> = { sourceKey: videoKey, audioKey, language: 'auto', quality, consent: true };
  const synced = await ctx.callCapability(
    'LIPSYNC',
    {
      generationId: ctx.row.id,
      workspaceId: ctx.row.workspaceId,
      params,
      files: {
        sourceKey: { url: videoUrl, mime: video.mime || 'video/mp4', bytes: bytes.byteLength },
        audioKey: { url: audioUrl, mime: 'audio/mpeg', bytes: audio.byteLength },
      },
    },
    {
      timeoutMs: Math.max(60_000, ctx.budgetMs - 60_000),
      signal: ctx.signal,
      onProgress: (detail, progress) => void ctx.stage('composing', Math.max(72, Math.min(88, progress ?? 75)), detail),
    },
  );
  const out = synced.artifacts.find((a) => a.role === 'video');
  if (!out) throw new ProviderError('RETRYABLE', `${synced.providerKey} returned no video`, synced.providerKey);
  return {
    video: { ...out, durationMs: out.durationMs ?? durationMs },
    providerKey: synced.providerKey,
    providerJobId: synced.providerJobId,
    costMinor: synced.costMinor,
  };
}
