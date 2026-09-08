/**
 * The gate's only job: never let more ffmpegs exist than the limit.
 *
 * Tested against the shape that actually broke the worker — four thumbnails
 * released at the same instant by four shots of one ad finishing together,
 * with a stitch arriving behind them.
 */
import { describe, expect, it, vi } from 'vitest';

const calls: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
let live = 0;
let highWater = 0;

vi.mock('node:child_process', () => ({
  // A fake ffmpeg that never finishes until the test says so, so overlap is
  // observable rather than a matter of timing luck.
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: unknown) => void) => {
    live += 1;
    highWater = Math.max(highWater, live);
    calls.push({
      resolve: () => {
        live -= 1;
        cb(null, { stdout: '', stderr: '' });
      },
      reject: (e: Error) => {
        live -= 1;
        cb(e, { stdout: '', stderr: '' });
      },
    });
  },
}));

vi.mock('./logger', () => ({ logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } }));

const { runFfmpeg, ffmpegLimit } = await import('./ffmpeg');

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the ffmpeg gate', () => {
  it('defaults to one at a time', () => {
    expect(ffmpegLimit()).toBe(1);
  });

  it('never runs two at once, however many arrive together', async () => {
    // Four thumbnails and a stitch, all started in the same tick.
    const runs = [
      runFfmpeg('thumbnail', ['a']),
      runFfmpeg('thumbnail', ['b']),
      runFfmpeg('thumbnail', ['c']),
      runFfmpeg('thumbnail', ['d']),
      runFfmpeg('stitch', ['e']),
    ];
    await settle();
    expect(live, 'five arrived together and more than one is running').toBe(1);

    // Drain them one at a time; each release must admit exactly one more.
    for (let i = 0; i < 5; i++) {
      expect(calls.length).toBe(i + 1);
      calls[i]!.resolve();
      await settle();
      expect(live).toBeLessThanOrEqual(1);
    }
    await Promise.all(runs);
    expect(highWater, 'the most that ever ran at once').toBe(1);
    expect(calls.length, 'every one of them ran').toBe(5);
  });

  it('hands the slot on even when ffmpeg fails', async () => {
    const before = calls.length;
    const bad = runFfmpeg('thumbnail', ['boom']);
    const next = runFfmpeg('stitch', ['after']);
    await settle();
    calls[before]!.reject(new Error('ffmpeg exploded'));
    await expect(bad).rejects.toThrow('ffmpeg exploded');
    await settle();
    // The failure must not strand the slot, or the worker quietly stops
    // stitching anything ever again — worse than the crash it replaced.
    expect(calls.length, 'the waiting job never started').toBe(before + 2);
    calls[before + 1]!.resolve();
    await next;
  });
});
