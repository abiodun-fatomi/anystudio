/**
 * Is this description a near-copy of one this workspace already has?
 *
 * MinHash over word 3-grams: sixty-four hash functions, the minimum of
 * each over the shingles, and the fraction of positions that agree between
 * two texts estimates their Jaccard similarity. Good enough to catch "the
 * same paragraph with the colour changed" — which is exactly what a model
 * produces for the fortieth ankara bag in a catalogue — and cheap enough to
 * run on every description against the workspace's last few hundred.
 */

import { createHash } from 'node:crypto';

export const HASHES = 64;
/** Estimated Jaccard at or above this is "the same description". */
export const NEAR_DUPLICATE = 0.55;

const SEEDS = Array.from({ length: HASHES }, (_, i) => 0x9e3779b9 * (i + 1));

export function shingles(text: string, n = 3): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/** 32-bit FNV-1a, salted per hash function. Deterministic across processes and deploys. */
function h32(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function minhash(text: string): number[] {
  const sh = shingles(text);
  const out = new Array<number>(HASHES).fill(0x7fffffff);
  if (sh.size === 0) return out;
  for (const s of sh) {
    for (let i = 0; i < HASHES; i++) {
      const v = h32(s, SEEDS[i]!) & 0x7fffffff; // fits a Postgres INTEGER
      if (v < out[i]!) out[i] = v;
    }
  }
  return out;
}

export function similarity(a: number[], b: number[]): number {
  let same = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
  return n === 0 ? 0 : same / n;
}

/** The phrases two texts share, for quoting back to the model. */
export function sharedPhrases(a: string, b: string, limit = 6): string[] {
  const sb = shingles(b, 4);
  const out: string[] = [];
  for (const s of shingles(a, 4)) {
    if (sb.has(s)) {
      out.push(s);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export const sha = (text: string) => createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
