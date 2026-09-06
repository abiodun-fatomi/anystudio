/**
 * A person on camera for a "filmed by a customer" ad.
 *
 * The talking segment is made in three steps, none of them a routed shot:
 *
 *   1. VOICE. The script is read by a VOICEOVER vendor — a catalogue voice,
 *      or the workspace's own clone — and stored beside the ad's work files.
 *   2. FACE. The presenter vendor (HeyGen) films a stock look, or the seller
 *      from one photo, saying exactly that audio; the clip is as long as the
 *      audio.
 *   3. The clip becomes shot one and the speech becomes the ad's voiceover,
 *      laid from zero by the stitcher so the lips and the sound line up.
 *
 * The result is written on the row (`presenterClip`) before the product
 * shots are dispatched, so a retry of the parent never films it twice.
 */
import { ProviderError, presenter as findPresenter, type CapabilityParams } from '@anystudio/shared';
import type { PipelineContext } from './index';
import { MediaService } from '../../modules/media/media.service';
import { fetchBytes } from '../../modules/provider/adapters/http';
import { durationOf } from './ffmpeg';

export type PresenterClip = NonNullable<CapabilityParams<'IMAGE_TO_VIDEO'>['presenterClip']>;

/** Whether this ad wants a presenter, and the request is one we can honour. */
export function wantsPresenter(p: CapabilityParams<'IMAGE_TO_VIDEO'>): boolean {
  return Boolean(p.presenter) && p.format === 'ugc' && p.shots > 1;
}

export async function renderPresenter(
  ctx: PipelineContext,
  p: CapabilityParams<'IMAGE_TO_VIDEO'>,
  script: string,
): Promise<{ clip: PresenterClip; costMinor: number }> {
  const want = p.presenter!;
  const lab = ctx.presenterLab('heygen');
  if (!lab) throw new ProviderError('PROVIDER_DOWN', 'no presenter vendor is configured (HEYGEN_API_KEY)', 'presenter');
  if (want.kind === 'photo' && !want.photoKey) throw new ProviderError('INVALID_INPUT', 'a presenter from a photo needs the photo', 'presenter');
  if (want.kind === 'photo' && want.consent !== true)
    throw new ProviderError('INVALID_INPUT', 'a presenter from a photo needs consent for the person in it', 'presenter');
  const stock = want.kind === 'stock' ? findPresenter(want.key) : undefined;
  if (want.kind === 'stock' && !stock) throw new ProviderError('INVALID_INPUT', `unknown presenter "${want.key}"`, 'presenter');

  // 1. the voice
  let providerVoiceId: string | undefined;
  let language = 'en';
  let only: string | undefined;
  if (want.voiceId) {
    const voice = await ctx.db.voiceProfile.findUnique({ where: { key: want.voiceId } });
    if (!voice || !voice.active || (voice.kind === 'CLONE' && voice.workspaceId !== ctx.row.workspaceId))
      throw new ProviderError('INVALID_INPUT', `unknown voice "${want.voiceId}"`, 'presenter');
    providerVoiceId = voice.providerVoiceId;
    language = voice.language.split('-')[0] ?? 'en';
    only = voice.providerKey;
  }
  await ctx.stage('generating', 14, 'recording what the presenter says');
  const spoken = await ctx.callCapability(
    'VOICEOVER',
    {
      generationId: ctx.row.id,
      workspaceId: ctx.row.workspaceId,
      params: { script, language, voiceId: want.voiceId, style: 'natural', speed: 1, providerVoiceId },
      files: {},
    },
    { timeoutMs: 3 * 60_000, signal: ctx.signal, route: only ? { only } : undefined },
  );
  const take = spoken.artifacts.find((a) => a.role === 'audio');
  const audio = take?.bytes ?? (take?.url ? (await fetchBytes(spoken.providerKey, take.url, 60_000)).bytes : undefined);
  if (!audio) throw new ProviderError('RETRYABLE', `${spoken.providerKey} returned no audio for the presenter`, spoken.providerKey);
  const audioMime = take?.mime ?? 'audio/mpeg';
  const audioExt = audioMime === 'audio/wav' ? 'wav' : 'mp3';
  const durationMs = await durationOf(audio, audioExt);
  const scope = `gen/${ctx.row.id}/work`;
  const audioKey = MediaService.key(ctx.row.workspaceId, scope, `presenter.${audioExt}`, ctx.row.createdAt);
  await ctx.media.put(audioKey, audio, audioMime);
  ctx.log.info({ audioKey, durationMs, words: script.split(/\s+/).length, providerKey: spoken.providerKey }, 'presenter speech recorded');

  // 2. the face
  await ctx.stage('generating', 18, stock ? `filming ${stock.name}` : 'filming you');
  // Their photo has to be theirs: an asset of this workspace, finished uploading.
  const photoAsset = want.kind === 'photo' ? await ctx.media.requireReady(ctx.row.workspaceId, want.photoKey!) : null;
  const photo = photoAsset ? await ctx.media.getBytes(photoAsset.key) : undefined;
  const photoMime = photoAsset?.mime ?? 'image/jpeg';
  const filmed = await lab.talkingVideo(
    {
      avatarId: stock?.providerAvatarId,
      photo: photo ? { bytes: new Uint8Array(photo), mime: photoMime } : undefined,
      audioUrl: await ctx.media.signRead(audioKey, 60 * 60),
      aspect: p.aspect,
      title: `anystudio ${ctx.row.id} presenter`,
    },
    {
      timeoutMs: 8 * 60_000,
      signal: ctx.signal,
      onProgress: (detail, progress) => void ctx.stage('generating', Math.min(40, 18 + (progress ?? 0) * 0.2), detail),
    },
  );
  const { bytes: video } = await fetchBytes(lab.key, filmed.url, 5 * 60_000);
  const key = MediaService.key(ctx.row.workspaceId, scope, 'presenter.mp4', ctx.row.createdAt);
  await ctx.media.put(key, video, 'video/mp4');
  ctx.log.info({ key, durationMs, providerJobId: filmed.providerJobId, presenter: stock?.key ?? 'photo' }, 'presenter filmed');

  return {
    clip: { key, audioKey, durationMs: Math.max(500, Math.round(durationMs)), script },
    costMinor: (spoken.costMinor ?? 0) + lab.presenterCostMinor(durationMs / 1000),
  };
}
