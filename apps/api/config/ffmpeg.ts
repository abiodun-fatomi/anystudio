/**
 * Every ffmpeg this process runs, through one door.
 *
 * WHY
 * ---
 * The worker was killed mid-stitch four times in a day, and the stitch was
 * never the whole story. Measured on a four-shot ad:
 *
 *   one video thumbnail          80 MB
 *   the 30-second stitch        260 MB at 720p, 407 at 1080p
 *   Node itself                 182 MB
 *
 * An ad's shots finish within a second of each other, and each one grabs a
 * thumbnail as it lands — so four thumbnail processes (320 MB) were still
 * exiting when the stitch started, on a 512 MB box. Nothing anywhere counted
 * how many ffmpegs existed at once, because nothing owned that question.
 *
 * The queue's concurrency could not answer it either: those thumbnails belong
 * to four DIFFERENT jobs on `media.heavy`, and the stitch is one job on
 * `media.local`. Three slots, four processes, one memory budget.
 *
 * So the count lives here instead. One ffmpeg at a time by default, which
 * makes the worst case Node plus the largest single child, and the largest
 * single child is now a number we know. Raise FFMPEG_CONCURRENCY on a box
 * with room; the encoder is CPU-bound anyway, so on a fraction of a core
 * running two is not faster, only heavier.
 *
 * A job that has to wait says so once. Silence here would turn a memory
 * problem into a mysterious latency one.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger';

const exec = promisify(execFile);

const MAX = Math.max(1, Number(process.env.FFMPEG_CONCURRENCY ?? 1));

let active = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  // The slot is handed straight to whoever is next rather than decremented
  // and re-taken: between those two steps another caller could slip in and
  // put us over the limit, which is the one thing this exists to prevent.
  if (next) next();
  else active -= 1;
}

export interface FfmpegOpts {
  /** stdout cap. A frame grab returns a PNG on the pipe; a stitch writes a file and returns nothing. */
  maxBuffer?: number;
  timeout?: number;
  signal?: AbortSignal;
  encoding?: 'buffer';
}

/**
 * Run ffmpeg, waiting for a free slot first.
 *
 * `what` names the caller in the log — "thumbnail" or "stitch" — so a wait
 * shows which kind of work is queueing behind which.
 */
export async function runFfmpeg(what: string, args: string[], opts: FfmpegOpts = {}): Promise<{ stdout: Buffer | string; stderr: Buffer | string }> {
  if (active >= MAX) logger.debug({ what, active, max: MAX, waiting: waiting.length }, 'ffmpeg is busy; waiting for a slot');
  await acquire();
  const started = Date.now();
  try {
    return await exec('ffmpeg', args, {
      maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
      timeout: opts.timeout,
      signal: opts.signal,
      ...(opts.encoding ? { encoding: opts.encoding } : {}),
    });
  } finally {
    release();
    logger.debug({ what, ms: Date.now() - started, active, waiting: waiting.length }, 'ffmpeg done');
  }
}

/** ffprobe is cheap — it decodes nothing — so it does not take a slot. */
export async function runFfprobe(args: string[]): Promise<string> {
  const { stdout } = await exec('ffprobe', args);
  return String(stdout);
}

/** For tests and for the boot log: what the gate is set to. */
export const ffmpegLimit = (): number => MAX;
