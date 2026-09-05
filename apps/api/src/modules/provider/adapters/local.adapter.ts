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

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ProviderError, type CapabilityParams, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { fetchBytes } from './http';

const exec = promisify(execFile);

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
    const dir = await mkdtemp(join(tmpdir(), 'stitch-'));
    try {
      const shots = Object.entries(input.files)
        .filter(([name]) => name.startsWith('shotKeys['))
        .sort(([a], [b]) => index(a) - index(b));
      if (shots.length === 0) throw new ProviderError('INVALID_INPUT', 'stitch: no shots', this.key);

      opts.onProgress?.('fetching shots', 5);
      const shotPaths: string[] = [];
      for (const [i, [, f]] of shots.entries()) {
        const { bytes } = await fetchBytes(this.key, f.url, opts.timeoutMs);
        const path = join(dir, `shot-${i}.mp4`);
        await writeFile(path, bytes);
        shotPaths.push(path);
      }
      let musicPath: string | undefined;
      let voPath: string | undefined;
      if (input.files.musicKey) {
        musicPath = join(dir, 'music');
        await writeFile(musicPath, (await fetchBytes(this.key, input.files.musicKey.url, opts.timeoutMs)).bytes);
      }
      if (input.files.voiceoverKey) {
        voPath = join(dir, 'vo');
        await writeFile(voPath, (await fetchBytes(this.key, input.files.voiceoverKey.url, opts.timeoutMs)).bytes);
      }

      opts.onProgress?.('assembling', 30);
      // The end card starts where the last shot ends; that needs the real durations.
      const durations = await Promise.all(shotPaths.map((s) => probeDurationMs(s).catch(() => 5000)));
      const endStartSec = durations.reduce((a, b) => a + b, 0) / 1000;
      const out = join(dir, 'out.mp4');
      const args = buildArgs(p, shotPaths, { musicPath, voPath, out, endStartSec });
      const started = Date.now();
      try {
        await exec('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeoutMs, signal: opts.signal });
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        throw new ProviderError('RETRYABLE', `ffmpeg failed: ${(e.stderr ?? e.message ?? '').slice(-800)}`, this.key);
      }
      opts.onProgress?.('encoding done', 90);
      const bytes = await readFile(out);
      const frame = FRAME[p.aspect];
      const durationMs = await probeDurationMs(out).catch(() => undefined);
      return {
        providerKey: this.key,
        costMinor: 0,
        artifacts: [{ bytes: new Uint8Array(bytes), mime: 'video/mp4', role: 'video', width: frame.w, height: frame.h, durationMs }],
        meta: { shots: shotPaths.length, encodeMs: Date.now() - started },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

const index = (name: string): number => Number(name.slice('shotKeys['.length, -1));

/** The ffmpeg command. Kept as one function so a change to the look is one diff. */
function buildArgs(
  p: CapabilityParams<'VIDEO_STITCH'>,
  shots: string[],
  io: { musicPath?: string; voPath?: string; out: string; endStartSec: number },
): string[] {
  const { w, h } = FRAME[p.aspect];
  const args: string[] = ['-v', 'error', '-y'];
  for (const s of shots) args.push('-i', s);
  let audioIdx = shots.length;
  const musicIdx = io.musicPath ? audioIdx++ : -1;
  const voIdx = io.voPath ? audioIdx++ : -1;
  if (io.musicPath) args.push('-stream_loop', '-1', '-i', io.musicPath);
  if (io.voPath) args.push('-i', io.voPath);

  const f: string[] = [];
  // Normalise every shot to the frame: scale to cover, crop centre, 30 fps, sane pixel format.
  shots.forEach((_, i) => {
    f.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=30,format=yuv420p,setsar=1[v${i}]`);
  });
  // End card: a 2-second brand-coloured frame with the closing line.
  const endCardSecs = p.endCard ? 2 : 0;
  let concatInputs = shots.map((_, i) => `[v${i}]`).join('');
  let n = shots.length;
  if (p.endCard) {
    f.push(`color=c=0x17131A:s=${w}x${h}:d=${endCardSecs}:r=30,format=yuv420p,setsar=1[vend]`);
    concatInputs += '[vend]';
    n += 1;
  }
  f.push(`${concatInputs}concat=n=${n}:v=1:a=0[vcat]`);

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
      `drawtext=text='made on studo':fontsize=${Math.round(h * 0.018)}:fontcolor=white@0.7:x=w-text_w-${Math.round(w * 0.04)}:y=h-text_h-${Math.round(h * 0.025)}`,
    );
  }
  f.push(`[vcat]${layers.length ? layers.join(',') : 'null'}[vout]`);

  // Audio: music bed ducked under the voiceover, or silence so every output has an audio track.
  if (musicIdx >= 0 && voIdx >= 0) {
    f.push(
      `[${musicIdx}:a]volume=0.8[m];[${voIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[vo1][vo2];[m][vo1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[md];[md][vo2]amix=inputs=2:duration=first:dropout_transition=2,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`,
    );
  } else if (musicIdx >= 0) {
    f.push(`[${musicIdx}:a]volume=0.9,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
  } else if (voIdx >= 0) {
    f.push(`[${voIdx}:a]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
  } else {
    f.push(`anullsrc=r=48000:cl=stereo[aout]`);
  }

  // Bound the output by the picture, never by the audio: a short voiceover must not cut the ad.
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', (io.endStartSec + endCardSecs).toFixed(2));
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-color_range', 'tv');
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', io.out);
  return args;
}

/** ffmpeg's drawtext quoting rules: escape the characters that end or break the expression. */
function esc(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '%%').replace(/\n/g, ' ');
}

async function probeDurationMs(path: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
  return Math.round(Number(stdout.trim()) * 1000);
}
