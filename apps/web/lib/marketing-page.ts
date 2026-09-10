/**
 * Marketing pages the server builds at request time — careers, whose
 * openings come from the database. They wear the same chrome as the static
 * pages (head, nav, footer, script from design/landing.html) so a visitor
 * cannot tell which pages are files and which are made on the spot.
 *
 * Runs on the Workers runtime: no Node APIs.
 */
import { CHROME } from '@/content/chrome';
import { siblingOrigin } from '@/lib/hosts';

export interface MarketingMeta {
  path: string;
  title: string;
  ogTitle?: string;
  description: string;
}

export function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A full document: chrome around `body`, plus any page-only style/script. */
export function marketingPage(meta: MarketingMeta, body: string, extra: { style?: string; script?: string } = {}): Response {
  const head = CHROME.head
    .split('__TITLE__')
    .join(esc(meta.title))
    .split('__OG_TITLE__')
    .join(esc(meta.ogTitle ?? meta.title))
    .split('__DESCRIPTION__')
    .join(esc(meta.description))
    .split('__PATH__')
    .join(meta.path);
  const nav = CHROME.nav.replace(
    `<a href="${meta.path.split('/').slice(0, 2).join('/')}">`,
    `<a href="${meta.path.split('/').slice(0, 2).join('/')}" aria-current="page">`,
  );
  const html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n${head}${extra.style ? `\n<style>${extra.style}</style>` : ''}\n${nav}\n${body}\n${CHROME.footer}\n${CHROME.script}${extra.script ? `\n<script>${extra.script}</script>` : ''}\n</html>\n`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60, stale-while-revalidate=600' },
  });
}

/** Read from the API as the server, for the environment this request came from. */
export async function apiGet<T>(req: Request, path: string): Promise<T | null> {
  const host = req.headers.get('host') ?? '';
  const res = await fetch(`${siblingOrigin(host, 'api')}/api/v1${path}`, { headers: { accept: 'application/json' } }).catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: T } | null;
  return body?.data ?? null;
}

/**
 * Plain text to HTML the way the console's textarea promised: blank lines
 * split paragraphs, lines starting with "- " make a list, a short line
 * ending with ":" is a heading.
 */
export function prose(text: string): string {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  return blocks
    .map((b) => {
      const lines = b.split('\n').filter((l) => l.trim());
      if (!lines.length) return '';
      if (lines.every((l) => /^\s*-\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${esc(l.replace(/^\s*-\s+/, ''))}</li>`).join('')}</ul>`;
      if (lines.length === 1 && lines[0]!.trim().endsWith(':') && lines[0]!.length < 80) return `<h3>${esc(lines[0]!.trim().slice(0, -1))}</h3>`;
      return `<p>${lines.map(esc).join('<br>')}</p>`;
    })
    .join('\n');
}
