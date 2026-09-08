/**
 * The local adapter: work we do ourselves, with ffmpeg, and pay nobody for.
 *
 * VIDEO_STITCH turns a list of generated shots into one ad: every shot is
 * normalised to the target frame (so a 5-second clip from one vendor and an
 * 8-second clip from another cut together), concatenated, given a music bed
 * ducked under any voiceover, captioned from a timed list, watermarked, and
 * closed with an end card. Deterministic, so a re-run is byte-identical and
 * a failed stitch never costs a vendor call.
 *
 * ffmpeg is a runtime dependency of the WORKER image only. The API never
 * stitches; it would tie up a request for thirty seconds.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError, type CapabilityParams, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { logger } from '../../../../config/logger';
import { runFfmpeg, runFfprobe } from '../../../../config/ffmpeg';
import { memoryMb } from '../../../../config/media-runtime';
import { BaseProvider } from './base';
import { fetchBytes } from './http';

const FRAME: Record<'9:16' | '1:1' | '16:9', { w: number; h: number }> = {
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '16:9': { w: 1920, h: 1080 },
};

export class LocalProvider extends BaseProvider {
  constructor() {
    super('local:ffmpeg', ['VIDEO_STITCH']);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    if (input.capability !== 'VIDEO_STITCH') this.unsupported(input.capability);
    const p = this.params(input, 'VIDEO_STITCH');
    const deadline = Date.now() + Math.max(0, opts.timeoutMs);
    const remaining = (): number => {
      if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('aborted');
      const ms = Math.floor(deadline - Date.now());
      if (ms <= 0) throw new ProviderError('RETRYABLE', `${this.key}: stitch budget exhausted after ${opts.timeoutMs}ms`, this.key);
      return ms;
    };
    const dir = await mkdtemp(join(tmpdir(), 'stitch-'));
    try {
      const shots = Object.entries(input.files)
        .filter(([name]) => name.startsWith('shotKeys['))
        .sort(([a], [b]) => index(a) - index(b));
      if (shots.length === 0) throw new ProviderError('INVALID_INPUT', 'stitch: no shots', this.key);

      opts.onProgress?.('Gathering the shots', 5);
      const shotPaths: string[] = [];
      for (const [i, [, f]] of shots.entries()) {
        const { bytes } = await fetchBytes(this.key, f.url, remaining(), opts.signal);
        const path = join(dir, `shot-${i}.mp4`);
        await writeFile(path, bytes);
        shotPaths.push(path);
      }
      let musicPath: string | undefined;
      let voPath: string | undefined;
      if (input.files.musicKey) {
        musicPath = join(dir, 'music');
        await writeFile(musicPath, (await fetchBytes(this.key, input.files.musicKey.url, remaining(), opts.signal)).bytes);
      }
      if (input.files.voiceoverKey) {
        voPath = join(dir, 'vo');
        await writeFile(voPath, (await fetchBytes(this.key, input.files.voiceoverKey.url, remaining(), opts.signal)).bytes);
      }

      opts.onProgress?.('Assembling your ad', 30);
      const sourceDurationsMs = await Promise.all(shotPaths.map((s) => probeOr(s, remaining, opts.signal, probeDurationMs, 5000)));
      const shotHasAudio = p.preserveShotAudio
        ? await Promise.all(shotPaths.map((s) => probeOr(s, remaining, opts.signal, probeHasAudio, false)))
        : shotPaths.map(() => false);
      // Multi-vendor duration grids differ. The pipeline supplies the paid
      // timeline; otherwise a standalone/manual stitch keeps each source's
      // real length. buildArgs trims long clips and pads short ones.
      const timelineMs = p.shotDurationsMs ?? sourceDurationsMs;
      const endStartSec = timelineMs.reduce((a, b) => a + b, 0) / 1000;
      const sourceWidth = await probeWidth(shotPaths[0]!, remaining(), opts.signal);
      const size = outputSize(p.aspect, sourceWidth);
      const out = join(dir, 'out.mp4');
      const args = buildArgs(p, shotPaths, { musicPath, voPath, out, endStartSec, size, timelineMs, shotHasAudio });
      // Said BEFORE ffmpeg runs, because the interesting case is the one where
      // it never returns: a stitch that takes the instance down leaves no
      // artifact, no meta and no error, just the log starting over. What it
      // chose has to be on the record before it starts.
      logger.info(
        {
          shots: shotPaths.length,
          sourceWidth,
          width: size.w,
          height: size.h,
          sourceDurationsMs,
          timelineMs,
          shotHasAudio,
          targetDurationMs: p.targetDurationMs,
          seconds: Math.round(endStartSec),
          ...memoryMb(),
        },
        'stitching',
      );
      const started = Date.now();
      try {
        await runFfmpeg('stitch', args, { maxBuffer: 4 * 1024 * 1024, timeout: remaining(), signal: opts.signal });
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        throw new ProviderError('RETRYABLE', `ffmpeg failed: ${(e.stderr ?? e.message ?? '').slice(-800)}`, this.key);
      }
      opts.onProgress?.('Finishing the file', 90);
      const bytes = await readFile(out);
      const durationMs = await probeOr(out, remaining, opts.signal, probeDurationMs, undefined);
      // A view over the same memory, not a second copy of a 20 MB file.
      const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      logger.info({ encodeMs: Date.now() - started, bytes: bytes.byteLength, width: size.w, height: size.h, ...memoryMb() }, 'ad assembled');
      return {
        providerKey: this.key,
        costMinor: 0,
        artifacts: [{ bytes: view, mime: 'video/mp4', role: 'video', width: size.w, height: size.h, durationMs }],
        meta: { shots: shotPaths.length, encodeMs: Date.now() - started, width: size.w, height: size.h },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

const index = (name: string): number => Number(name.slice('shotKeys['.length, -1));

/** The ffmpeg command. Kept as one function so a change to the look is one diff. */
export function buildArgs(
  p: CapabilityParams<'VIDEO_STITCH'>,
  shots: string[],
  io: {
    musicPath?: string;
    voPath?: string;
    out: string;
    endStartSec: number;
    size: { w: number; h: number };
    timelineMs: number[];
    shotHasAudio?: boolean[];
  },
): string[] {
  const { w, h } = io.size;
  const args: string[] = ['-v', 'error', '-y'];
  for (const s of shots) args.push('-i', s);
  let audioIdx = shots.length;
  const musicIdx = io.musicPath ? audioIdx++ : -1;
  const voIdx = io.voPath ? audioIdx++ : -1;
  if (io.musicPath) args.push('-stream_loop', '-1', '-i', io.musicPath);
  if (io.voPath) args.push('-i', io.voPath);

  const f: string[] = [];
  // Normalise every shot to the frame and its planned timeline slot. tpad
  // clones only when a provider returned a shorter grid length; trim cuts a
  // longer one. setpts makes concat see every segment from zero.
  shots.forEach((_, i) => {
    const seconds = Math.max(0.5, io.timelineMs[i]! / 1000).toFixed(3);
    f.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=30,format=yuv420p,setsar=1,tpad=stop_mode=clone:stop_duration=${seconds},trim=duration=${seconds},setpts=PTS-STARTPTS[v${i}]`,
    );
    if (p.preserveShotAudio) {
      f.push(
        io.shotHasAudio?.[i]
          ? `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=pad_dur=${seconds},atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${i}]`
          : `anullsrc=r=48000:cl=stereo:d=${seconds}[a${i}]`,
      );
    }
  });
  // Reserve the exact remainder for the end card. For old/manual stitch
  // requests without a target this keeps the historical two seconds.
  const targetSeconds = p.targetDurationMs ? p.targetDurationMs / 1000 : undefined;
  const endCardSecs = p.endCard ? Math.max(0, targetSeconds === undefined ? 2 : targetSeconds - io.endStartSec) : 0;
  let concatInputs = shots.map((_, i) => `[v${i}]${p.preserveShotAudio ? `[a${i}]` : ''}`).join('');
  let n = shots.length;
  if (p.endCard) {
    f.push(`color=c=0x17131A:s=${w}x${h}:d=${endCardSecs}:r=30,format=yuv420p,setsar=1[vend]`);
    if (p.preserveShotAudio) f.push(`anullsrc=r=48000:cl=stereo:d=${endCardSecs.toFixed(3)}[aend]`);
    concatInputs += `[vend]${p.preserveShotAudio ? '[aend]' : ''}`;
    n += 1;
  }
  f.push(`${concatInputs}concat=n=${n}:v=1:a=${p.preserveShotAudio ? 1 : 0}[vcat]${p.preserveShotAudio ? '[acat]' : ''}`);

  // Captions and watermark are drawtext layers over the concatenated stream.
  const layers: string[] = [];
  for (const c of p.captions) {
    layers.push(
      `drawtext=text='${esc(c.text)}':fontsize=${Math.round(h * 0.032)}:fontcolor=white:borderw=3:bordercolor=black@0.6:x=(w-text_w)/2:y=h*0.82:enable='between(t,${(c.fromMs / 1000).toFixed(2)},${(c.toMs / 1000).toFixed(2)})'`,
    );
  }
  if (p.endCard) {
    const tEnd = io.endStartSec.toFixed(2);
    layers.push(
      `drawtext=text='${esc(p.endCard.text)}':fontsize=${Math.round(h * 0.045)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(h * 0.03)}:enable='gte(t,${tEnd})'`,
    );
    if (p.endCard.price) {
      layers.push(
        `drawtext=text='${esc(p.endCard.price)}':fontsize=${Math.round(h * 0.06)}:fontcolor=0xFF3D93:x=(w-text_w)/2:y=(h-text_h)/2+${Math.round(h * 0.04)}:enable='gte(t,${tEnd})'`,
      );
    }
  }
  if (p.watermark) {
    layers.push(
      `drawtext=text='made on AnyStudio':fontsize=${Math.round(h * 0.018)}:fontcolor=white@0.7:x=w-text_w-${Math.round(w * 0.04)}:y=h-text_h-${Math.round(h * 0.025)}`,
    );
  }
  f.push(`[vcat]${layers.length ? layers.join(',') : 'null'}[vout]`);

  // Audio: every stream the concat filter creates must be consumed. Native
  // shot audio and music form a bed; speech ducks that bed and is mixed back
  // on top. Padding the voice track to the picture length also lets product
  // audio resume after a presenter's opening instead of ending the whole mix.
  const audioSeconds = (targetSeconds ?? io.endStartSec + endCardSecs).toFixed(3);
  const hasNative = p.preserveShotAudio;
  if (voIdx >= 0 && (musicIdx >= 0 || hasNative)) {
    const beds: string[] = [];
    if (hasNative) {
      f.push(`[acat]volume=0.80[anative]`);
      beds.push('[anative]');
    }
    if (musicIdx >= 0) {
      f.push(`[${musicIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.65[amusic]`);
      beds.push('[amusic]');
    }
    if (beds.length === 2) f.push(`${beds.join('')}amix=inputs=2:duration=longest:dropout_transition=2[abed]`);
    else f.push(`${beds[0]}anull[abed]`);
    f.push(
      `[${voIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=pad_dur=${audioSeconds},atrim=duration=${audioSeconds},asplit=2[voside][vomix]`,
    );
    f.push(
      `[abed][voside]sidechaincompress=threshold=0.03:ratio=12:attack=20:release=400[aducked];[aducked][vomix]amix=inputs=2:duration=longest:dropout_transition=2,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`,
    );
  } else if (musicIdx >= 0 && hasNative) {
    f.push(
      `[${musicIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.65[amusic];[acat]volume=0.85[anative];[anative][amusic]amix=inputs=2:duration=longest:dropout_transition=2,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`,
    );
  } else if (musicIdx >= 0) {
    f.push(`[${musicIdx}:a]volume=0.9,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
  } else if (voIdx >= 0) {
    f.push(
      `[${voIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=pad_dur=${audioSeconds},atrim=duration=${audioSeconds},loudnorm=I=-14:TP=-1.5:LRA=11[aout]`,
    );
  } else if (p.preserveShotAudio) {
    f.push(`[acat]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
  } else {
    f.push(`anullsrc=r=48000:cl=stereo[aout]`);
  }

  // Bound the output by the picture, never by the audio: a short voiceover must not cut the ad.
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', (targetSeconds ?? io.endStartSec + endCardSecs).toFixed(3));
  // x264's own default was `medium`, which is three to five times slower than
  // `veryfast` at the same CRF — and the difference is a slightly larger file,
  // not a visibly worse one. That trade is wrong here twice over: this runs on
  // half a Render CPU, where it was minutes of the "Assembling your ad" wait a
  // seller sits through; and the file's next stop is Instagram or TikTok, which
  // re-encodes it on upload and throws our extra care away. Quality is CRF, and
  // CRF has not moved.
  //
  // `-threads` is capped for the same reason sharp's pool is: x264 sizes its
  // thread count from the CPUs it can SEE, which is the host's, and a 0.5-CPU
  // container asked for eight threads spends its time context-switching.
  args.push('-filter_complex_threads', process.env.STITCH_THREADS ?? '2');
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    process.env.STITCH_PRESET ?? 'veryfast',
    '-crf',
    '20',
    '-threads',
    process.env.STITCH_THREADS ?? '2',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-pix_fmt',
    'yuv420p',
    '-color_range',
    'tv',
  );
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', io.out);
  return args;
}

/** ffmpeg's drawtext quoting rules: escape the characters that end or break the expression. */
function esc(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '%%').replace(/\n/g, ' ');
}

async function probeDurationMs(path: string, timeout = 30_000): Promise<number> {
  const stdout = await runFfprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], timeout);
  return Math.round(Number(stdout.trim()) * 1000);
}

async function probeHasAudio(path: string, timeout = 30_000): Promise<boolean> {
  const stdout = await runFfprobe(['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', path], timeout);
  return stdout.trim().length > 0;
}

/** The pixel width of a shot, or null when ffprobe cannot say. */
async function probeWidth(path: string, timeout = 30_000, signal?: AbortSignal): Promise<number | null> {
  try {
    const stdout = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', path], timeout);
    const w = Number(stdout.trim());
    return Number.isFinite(w) && w > 0 ? w : null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

async function probeOr<T>(
  path: string,
  remaining: () => number,
  signal: AbortSignal | undefined,
  probe: (path: string, timeout?: number) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await probe(path, remaining());
  } catch (err) {
    if (signal?.aborted || err instanceof ProviderError) throw err;
    return fallback;
  }
}

/**
 * The size to encode the ad at.
 *
 * FRAME is the shape the ad is FOR, and it used to be the size as well —
 * every stitch encoded 1080x1920 whatever it was handed. The vendors return
 * 720p (see the provider rows), so that was an upscale: no detail gained,
 * and measured on a four-shot 30-second ad it cost 27 seconds and a 637 MB
 * ffmpeg against 6 seconds and 260 MB at the source size. On a 512 MB
 * worker with Node already holding 165 MB, the 1080 encode does not fit,
 * which is how an ad reached "Assembling your ad" and then took the whole
 * process down with it.
 *
 * So the shape comes from the aspect and the SIZE comes from the material,
 * capped at the frame. Hand it 1080p shots and it encodes 1080p; hand it
 * 720p and it stops pretending. STITCH_MAX_WIDTH lowers the cap further on
 * a small box, and raising the instance needs no code change at all.
 */
function outputSize(aspect: '9:16' | '1:1' | '16:9', sourceWidth: number | null): { w: number; h: number } {
  const frame = FRAME[aspect];
  const cap = Number(process.env.STITCH_MAX_WIDTH ?? frame.w);
  const w = Math.max(360, Math.min(frame.w, cap, sourceWidth ?? frame.w));
  const even = (n: number) => Math.round(n / 2) * 2;
  return { w: even(w), h: even((w * frame.h) / frame.w) };
}
