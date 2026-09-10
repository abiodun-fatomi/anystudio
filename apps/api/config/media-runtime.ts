/**
 * Native-library limits for the worker process.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * The worker was OOM-killed on a 512 MB Render instance and the alert
 * offered "a memory leak in your application" as the first explanation. It
 * is worth being precise about which kind, because the fix is different:
 * almost nothing here is retained JavaScript. What grows is memory held
 * OUTSIDE the V8 heap, by libraries that size themselves against the
 * machine rather than against the container.
 *
 * sharp/libvips keeps an operation cache — 50 MB by default — and starts a
 * thread pool sized to the CPU count it can see. A Render starter instance
 * is half a core, but the container still reports the host's cores, so
 * libvips cheerfully starts eight worker threads, each with its own
 * allocation arena, and RSS ratchets upwards and never comes back down.
 * From the outside that is indistinguishable from a leak: the graph climbs,
 * the process is killed, it restarts flat, it climbs again.
 *
 * So the caps are set explicitly, from the container's point of view, and
 * logged once at boot so the next incident starts from a fact rather than a
 * guess.
 *
 * The companion settings live where they have to: MALLOC_ARENA_MAX in the
 * Dockerfile (glibc reads it before any of our code runs) and
 * --max-old-space-size in render.yaml (V8 sizes its heap from HOST memory,
 * not the cgroup limit, so without it the container is killed long before
 * the garbage collector feels any pressure at all).
 */

import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { logger } from './logger';

/**
 * How much libvips may keep between operations, in MB.
 *
 * The cache pays off when the same image is processed repeatedly, which is
 * not what this worker does: every job is a different customer's photo,
 * seen once. So it is nearly all cost.
 */
const CACHE_MB = Number(process.env.SHARP_CACHE_MB ?? 32);

/**
 * How many threads libvips may use per operation.
 *
 * One. The parallelism here is the queue's — up to fourteen jobs at once —
 * and letting each of them fan out again over the host's cores is how half
 * a CPU ends up with eighty threads.
 */
const THREADS = Number(process.env.SHARP_CONCURRENCY ?? 1);

export function tuneMediaRuntime(): void {
  sharp.cache({ memory: CACHE_MB, files: 0, items: 0 });
  sharp.concurrency(THREADS);
  logger.info(
    { cacheMb: CACHE_MB, threads: sharp.concurrency(), simd: sharp.simd(), arenaMax: process.env.MALLOC_ARENA_MAX ?? 'unset' },
    'image library capped to the container, not the host',
  );
}

const mb = (n: number) => Math.round(n / 1024 / 1024);

/**
 * What the CONTAINER is holding, which is not what this process is holding.
 *
 * A four-shot ad was killed mid-stitch with the heartbeat reporting a
 * comfortable 165 MB, because ffmpeg is a CHILD process: its 637 MB never
 * appeared in our rss, and the only evidence was the log starting over. A
 * number that cannot see the thing most likely to exhaust the box is worse
 * than no number, because it reads as reassurance.
 *
 * cgroup v2 first (`memory.current` / `memory.max`), then v1, then nothing —
 * outside a container there is no limit to report and that is not an error.
 */
function cgroupMb(): { used: number; limit: number } | null {
  const read = (path: string): number | null => {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (raw === 'max') return Infinity;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };
  const used = read('/sys/fs/cgroup/memory.current') ?? read('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const limit = read('/sys/fs/cgroup/memory.max') ?? read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  // A "limit" of the whole machine is the kernel saying there isn't one.
  if (used === null || limit === null || !Number.isFinite(limit) || limit > 64 * 1024 ** 3) return null;
  return { used: mb(used), limit: mb(limit) };
}

/**
 * What to report every heartbeat: this process, and the container around it.
 *
 * `rss` is Node. `containerUsed` includes every child — ffmpeg above all —
 * and is the number that decides whether the process is about to be killed.
 */
export function memoryMb(): {
  rss: number;
  heap: number;
  external: number;
  buffers: number;
  containerUsed?: number;
  containerLimit?: number;
  containerPct?: number;
} {
  const m = process.memoryUsage();
  const base = { rss: mb(m.rss), heap: mb(m.heapUsed), external: mb(m.external), buffers: mb(m.arrayBuffers) };
  const cg = cgroupMb();
  if (!cg) return base;
  return { ...base, containerUsed: cg.used, containerLimit: cg.limit, containerPct: Math.round((cg.used / cg.limit) * 100) };
}
