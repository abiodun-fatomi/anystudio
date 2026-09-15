/**
 * What a product page says about its product, read the way a link preview
 * reads it.
 *
 * A merchant on a marketplace has a listing URL long before they have a
 * clean photo. Given the page, find the picture the page itself presents as
 * the product — the Open Graph image first, because that is the one the
 * platform chose for sharing; Twitter's card next; then a schema.org
 * Product's image; and only then the first sizeable <img> in the markup —
 * plus the title, so the check and the copy have a name to work from.
 *
 * Pure: HTML in, candidates out. No fetching here, so it is tested with
 * strings and the fetch guard stays in one place (safe-fetch.ts).
 */

export interface ProductPageRead {
  /** Absolute image URLs, best first. Empty when the page presents no picture. */
  images: string[];
  /** The page's own name for the product, when it has one. */
  title: string | null;
}

const META = /<meta\s+[^>]*>/gi;
const IMG = /<img\s+[^>]*>/gi;
const LD_JSON = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function absolute(candidate: string, base: URL): string | null {
  try {
    const u = new URL(candidate.trim(), base);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Values of `content` for the meta tags whose property/name matches, in document order. */
function metaContents(html: string, keys: string[]): string[] {
  const out: string[] = [];
  for (const tag of html.match(META) ?? []) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    if (!keys.includes(key)) continue;
    const content = attr(tag, 'content');
    if (content) out.push(content);
  }
  return out;
}

/** Image URLs a schema.org Product declares, when the page carries one. */
function ldProductImages(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(LD_JSON)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      const type = String(o['@type'] ?? '');
      if (/product/i.test(type) && o.image !== undefined) {
        const img = o.image;
        const items = Array.isArray(img) ? img : [img];
        for (const i of items) {
          if (typeof i === 'string') out.push(i);
          else if (i && typeof i === 'object' && typeof (i as { url?: unknown }).url === 'string') out.push((i as { url: string }).url);
        }
      }
      if (o['@graph']) walk(o['@graph']);
    };
    walk(parsed);
  }
  return out;
}

/** The first <img> tags that look like content rather than chrome: no tiny declared size, not a data: URI, not an obvious icon. */
function contentImages(html: string, base: URL): string[] {
  const out: string[] = [];
  for (const tag of html.match(IMG) ?? []) {
    const src = attr(tag, 'src') ?? attr(tag, 'data-src') ?? attr(tag, 'data-original');
    if (!src || src.startsWith('data:')) continue;
    const w = Number(attr(tag, 'width') ?? 0);
    const h = Number(attr(tag, 'height') ?? 0);
    if ((w && w < 200) || (h && h < 200)) continue;
    if (/logo|icon|sprite|avatar|badge|flag|pixel|tracking|spacer/i.test(`${src} ${attr(tag, 'class') ?? ''} ${attr(tag, 'alt') ?? ''}`)) continue;
    const abs = absolute(src, base);
    if (abs) out.push(abs);
    if (out.length >= 5) break;
  }
  return out;
}

export function readProductPage(html: string, pageUrl: string): ProductPageRead {
  const base = new URL(pageUrl);
  const ordered = [
    ...metaContents(html, ['og:image:secure_url', 'og:image', 'og:image:url']),
    ...metaContents(html, ['twitter:image', 'twitter:image:src']),
    ...ldProductImages(html),
  ]
    .map((c) => absolute(c, base))
    .filter((c): c is string => c !== null);
  const images = [...new Set([...ordered, ...contentImages(html, base)])];

  const title =
    metaContents(html, ['og:title', 'twitter:title'])[0] ??
    (() => {
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      return m ? decode(m[1]!.replace(/\s+/g, ' ')) : null;
    })() ??
    null;

  return { images, title: title ? title.slice(0, 120) : null };
}
