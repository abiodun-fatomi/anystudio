/**
 * The two ffmpeg jobs the audio and video pipelines share. Each works on
 * bytes in a temp directory that is removed whatever happens; nothing here
 * knows about storage or rows.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ProviderError } from '@anystudio/shared';
import type { PipelineContext } from './index';

const exec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** The sound of a video as MP3, plus how long it is. A silent video is an error worth naming. */
export async function extractAudio(video: Uint8Array, ext: string): Promise<{ audio: Uint8Array; durationMs: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'extract-'));
  try {
    const src = join(dir, `in.${ext}`);
    const out = join(dir, 'audio.mp3');
    await writeFile(src, video);
    const durationMs = await probeDurationMs(src);
    try {
      await exec('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-c:a', 'libmp3lame', '-b:a', '160k', out], { maxBuffer: MAX_BUFFER });
    } catch (err) {
      throw new ProviderError('INVALID_INPUT', `the video has no usable audio track: ${err instanceof Error ? err.message.split('\n')[0] : err}`, 'ffmpeg');
    }
    return { audio: new Uint8Array(await readFile(out)), durationMs };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** How long a media file plays, or 0 when ffprobe cannot tell. */
export async function probeDurationMs(path: string): Promise<number> {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
    return Math.round(parseFloat(stdout.trim()) * 1000) || 0;
  } catch {
    return 0;
  }
}

/** The length of a media file given as bytes. */
export async function durationOf(bytes: Uint8Array, ext: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'probe-'));
  try {
    const src = join(dir, `in.${ext}`);
    await writeFile(src, bytes);
    return await probeDurationMs(src);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function extOf(mime: string): string {
  return ({ 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/ogg': 'ogg' } as Record<string, string>)[mime] ?? 'bin';
}

/**
 * Refuse a source longer than the price allows, before a vendor is paid.
 * ffprobe reads the container header over HTTP, so a 200 MB upload costs a
 * few kilobytes to measure; when it cannot tell (a stub, a private URL),
 * the vendor's own limit is the backstop.
 */
export async function guardLength(ctx: PipelineContext, fileName: string, maxSec: number): Promise<number> {
  const file = ctx.files[fileName];
  if (!file) throw new ProviderError('INVALID_INPUT', `${fileName} is missing`, 'ffmpeg');
  const ms = await probeDurationMs(file.url);
  if (ms > maxSec * 1000) {
    ctx.log.warn({ fileName, durationMs: ms, maxSec }, 'source is longer than the price allows');
    throw new ProviderError('INVALID_INPUT', `that video is ${Math.round(ms / 1000)} seconds long; the limit is ${maxSec / 60} minutes`, 'ffmpeg');
  }
  if (ms === 0) ctx.log.info({ fileName }, 'could not measure the source; the vendor will enforce its own limit');
  return ms;
}
