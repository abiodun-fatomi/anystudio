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

/** What the process is holding, in MB, for the heartbeat log. */
export function memoryMb(): { rss: number; heap: number; external: number; buffers: number } {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  return { rss: mb(m.rss), heap: mb(m.heapUsed), external: mb(m.external), buffers: mb(m.arrayBuffers) };
}
