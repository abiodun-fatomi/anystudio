/**
 * A song sung in the seller's own voice — experimental, and honest about it.
 *
 * No music model sings in a voice it has never heard, so the song is made
 * the usual way first, and then the singer is swapped:
 *
 *   1. STEMS. The vendor splits the finished track into the vocal and
 *      everything else (two_stems_v1), sample-aligned with the original.
 *   2. CONVERT. The vocal stem goes through speech-to-speech into the
 *      workspace's cloned voice. Melody, timing and words are the model's;
 *      the timbre is theirs.
 *   3. MIX. ffmpeg lays the converted vocal back over the instrumental.
 *
 * Every step can fail — a stems split that comes back odd, a conversion the
 * vendor refuses, a clone that has since been deleted — and none of them is
 * a reason to lose the song. Whatever fails, the caller gets the original
 * track back with a note saying the voice was not applied, and the seller
 * is told so on the result rather than left wondering why it does not
 * sound like them.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError, type CapabilityParams } from '@anystudio/shared';
import type { PipelineContext } from './index';
import { runFfmpeg } from '../../../config/ffmpeg';

export interface MyVoiceOutcome {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  /** Whether the song is now in their voice. */
  applied: boolean;
  /** Operator-facing when not applied; the customer sees `note`. */
  reason?: string;
  /** Customer-facing. */
  note: string;
  costMinor: number;
  voiceKey: string | null;
}

const STEP_BUDGET_MS = 5 * 60_000;

/**
 * @param track  the finished song as the music vendor returned it
 */
export async function singInMyVoice(
  ctx: PipelineContext,
  p: CapabilityParams<'MUSIC'>,
  track: { bytes: Uint8Array; mime: string; ext: string; seconds: number },
): Promise<MyVoiceOutcome> {
  const keep = (reason: string, note: string): MyVoiceOutcome => ({ ...track, applied: false, reason, note, costMinor: 0, voiceKey: p.voiceId ?? null });

  // The voice has to be theirs. Someone else's key, or a deleted one, is a request we cannot honour — and a refund, not a fallback.
  if (!p.voiceId) throw new ProviderError('INVALID_INPUT', 'singer is "me" but no voiceId was given', 'music-pipeline');
  const voice = await ctx.db.voiceProfile.findUnique({ where: { key: p.voiceId } });
  if (!voice || !voice.active || voice.kind !== 'CLONE' || voice.workspaceId !== ctx.row.workspaceId)
    throw new ProviderError('INVALID_INPUT', `voice "${p.voiceId}" is not one of this workspace's own voices`, 'music-pipeline');

  const lab = ctx.voiceLab(voice.providerKey);
  if (!lab) {
    ctx.log.warn({ providerKey: voice.providerKey }, 'my-voice: the voice vendor is not configured here; keeping the model singer');
    return keep(
      'vendor not configured',
      'Your voice could not be applied here — the voice vendor is not set up in this environment. This is the song in the studio voice.',
    );
  }

  const signal = ctx.signal;
  const budget = Math.min(STEP_BUDGET_MS, Math.max(60_000, ctx.budgetMs / 3));
  let cost = 0;

  // 1. stems
  let stems: { vocals: Uint8Array; instrumental: Uint8Array; mime: string };
  try {
    await ctx.stage('composing', 72, 'separating the vocal');
    stems = await lab.separateStems({ bytes: track.bytes, mime: track.mime, filename: `song.${track.ext}` }, { timeoutMs: budget, signal });
    cost += lab.voiceLabCostMinor('stems', track.seconds);
    ctx.log.info({ vocalsBytes: stems.vocals.byteLength, instrumentalBytes: stems.instrumental.byteLength }, 'my-voice: stems separated');
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : err }, 'my-voice: stem separation failed; keeping the model singer');
    return keep(
      `stems: ${err instanceof Error ? err.message : String(err)}`,
      'We could not separate the vocal this time, so this is the song in the studio voice. Try again and it usually works.',
    );
  }

  // 2. their voice
  let converted: { bytes: Uint8Array; mime: string };
  try {
    await ctx.stage('composing', 80, 'singing it in your voice');
    converted = await lab.convertVoice(
      voice.providerVoiceId,
      { bytes: stems.vocals, mime: stems.mime, filename: 'vocals.mp3' },
      { timeoutMs: budget, signal, language: p.language },
    );
    cost += lab.voiceLabCostMinor('convert', track.seconds);
    ctx.log.info({ bytes: converted.bytes.byteLength, voiceKey: voice.key }, 'my-voice: vocal converted');
  } catch (err) {
    const kind = err instanceof ProviderError ? err.kind : 'unknown';
    ctx.log.warn({ err: err instanceof Error ? err.message : err, kind }, 'my-voice: voice conversion failed; keeping the model singer');
    return {
      ...keep(
        `convert: ${err instanceof Error ? err.message : String(err)}`,
        kind === 'CONTENT_REJECTED'
          ? 'The voice vendor would not convert this vocal, so this is the song in the studio voice.'
          : 'Your voice could not be applied this time, so this is the song in the studio voice. Try again in a minute.',
      ),
      costMinor: cost,
    };
  }

  // 3. mix
  try {
    await ctx.stage('composing', 86, 'mixing');
    const mixed = await mix(stems.instrumental, converted.bytes);
    return {
      bytes: mixed,
      mime: 'audio/mpeg',
      ext: 'mp3',
      applied: true,
      note: 'Sung in your voice. Experimental: the melody and timing are the studio singer’s; the voice is yours.',
      costMinor: cost,
      voiceKey: voice.key,
    };
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.message : err }, 'my-voice: mixing failed; keeping the model singer');
    return {
      ...keep(
        `mix: ${err instanceof Error ? err.message : String(err)}`,
        'The mix failed at the last step, so this is the song in the studio voice. Try again.',
      ),
      costMinor: cost,
    };
  }
}

/** Instrumental + converted vocal → one MP3. `normalize=0` keeps levels as they were; the vocal is lifted a touch to sit in front. */
export async function mix(instrumental: Uint8Array, vocal: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'myvoice-'));
  try {
    const inst = join(dir, 'inst.mp3');
    const voc = join(dir, 'voc.mp3');
    const out = join(dir, 'song.mp3');
    await Promise.all([writeFile(inst, instrumental), writeFile(voc, vocal)]);
    await runFfmpeg(
      'mix-song',
      [
        '-v',
        'error',
        '-y',
        '-i',
        inst,
        '-i',
        voc,
        '-filter_complex',
        '[1:a]aresample=44100,volume=1.15[v];[0:a]aresample=44100[i];[i][v]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]',
        '-map',
        '[out]',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        out,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
