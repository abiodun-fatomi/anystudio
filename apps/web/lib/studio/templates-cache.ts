/**
 * The template catalogue, fetched once and shared by every picker.
 *
 * Unlike the voice list this memo has to expire, and the reason is the
 * thumbnails: each tile's URL is signed and good for fifteen minutes. A
 * promise memoised for the life of the tab would keep handing pickers the
 * same URLs long after they had lapsed, and the studio would slowly fill
 * with grey tiles for no reason a seller could understand.
 *
 * Ten minutes leaves a wide margin under that fifteen — a list handed out at
 * the last moment of the window still has a third of its validity left, which
 * is far longer than anyone spends choosing. The tiles fall back to their
 * gradient if a URL lapses anyway; this is what keeps that from being the
 * normal case rather than the rare one.
 */
import { api } from '../api';
import type { TemplateView } from '@anystudio/shared';

const TTL_MS = 10 * 60 * 1000;

let cached: { at: number; list: Promise<TemplateView[]> } | null = null;

export function templates(): Promise<TemplateView[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.list;
  const list = api.templates.list().catch((e: unknown) => {
    // A failed fetch must not be remembered: the next picker to open should
    // try again rather than inherit the failure for ten minutes.
    cached = null;
    throw e;
  });
  cached = { at: Date.now(), list };
  return list;
}

/** Drop the memo — the staff console calls this after editing the catalogue. */
export function forgetTemplates(): void {
  cached = null;
}
