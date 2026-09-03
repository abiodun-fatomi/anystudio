/**
 * Publish the static prototypes through the web app.
 *
 * design/landing.html and design/org.html are finished pages; rebuilding them
 * as React would be weeks of work for no user-visible gain. Instead each is
 * emitted as a string module under apps/web/content/ — with prototype links
 * rewritten to app routes and CDN media to /shots/ — and a Route Handler
 * returns it. The SEO files are copied into public/.
 *
 * The landing prototype is also SPLIT here. It was authored as one long page,
 * but pricing and the platform/API story are destinations people arrive at
 * directly and link to, so they get their own URLs. The three pages share one
 * source of chrome — head, nav, footer, script — which is the whole reason
 * this is a build step rather than three hand-maintained files that drift.
 *
 * Run after editing anything in design/:   node scripts/sync-prototypes.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = resolve(root, 'apps/web/public');
const content = resolve(root, 'apps/web/content');
mkdirSync(pub, { recursive: true });
mkdirSync(content, { recursive: true });

const shots = JSON.parse(readFileSync(resolve(root, 'scripts/shots.json'), 'utf8'));

/** Prototype href → route the app actually serves. */
const LINKS = [
  ['auth.html#signup', '/signup'],
  ['auth.html#login', '/login'],
  ['auth.html#forgot', '/forgot'],
  ['auth.html', '/login'],
  ['org.html#contact', '/org#contact'],
  ['org.html', '/org'],
  ['landing.html', '/'],
];

/** Sections that left the landing page, and where they went. */
const PROMOTED = [
  { id: 'pricing', path: '/pricing', label: 'Pricing' },
  { id: 'api', path: '/developers', label: 'For platforms' },
];

// --------------------------------------------------------------- helpers

function rewriteAssets(html) {
  for (const [local, cdn] of Object.entries(shots.files)) {
    html = html.split(`${shots.base}/${cdn}`).join(`/shots/${local}`);
  }
  const leftover = html.match(/https:\/\/d8j0ntlcm91z4\.cloudfront\.net[^"']+/g);
  if (leftover) throw new Error(`CDN links not in scripts/shots.json:\n${[...new Set(leftover)].join('\n')}`);
  return html;
}

function rewriteLinks(html) {
  for (const [from, to] of LINKS) html = html.split(`href="${from}"`).join(`href="${to}"`);
  return html;
}

/**
 * The prototypes were authored for a host that wraps them in a document
 * skeleton, so they start at <meta charset>. Served raw they would render in
 * quirks mode; wrap them.
 */
const wrap = (html) => `<!DOCTYPE html>\n<html lang="en">\n<head>\n${html}\n</html>\n`;

/** Split the landing prototype into the parts every page shares, and the rest. */
function dissect(html) {
  const headEnd = html.indexOf('</style>') + '</style>'.length;
  const navStart = html.indexOf('<header class="nav">');
  const navEnd = html.indexOf('</header>') + '</header>'.length;
  const footStart = html.indexOf('\n<footer>');
  const scriptStart = html.indexOf('\n<script>', footStart);
  if ([headEnd, navStart, navEnd, footStart, scriptStart].some((i) => i < 1)) {
    throw new Error('design/landing.html no longer has the expected head/nav/footer/script shape');
  }
  return {
    head: html.slice(0, headEnd),
    nav: html.slice(navStart, navEnd),
    body: html.slice(navEnd, footStart),
    footer: html.slice(footStart, scriptStart),
    script: html.slice(scriptStart),
  };
}

/** The body as top-level blocks: each <section>, with its banner comment. */
function blocks(body) {
  return body.split(/\n(?=(?:<!-- =+[^\n]*-->\n)?<section\b)/);
}

/**
 * Per-page metadata. Everything else in <head> — icons, theme colour, security
 * headers, the stylesheet — is identical on all three by design.
 */
function headFor(head, page) {
  const swap = (re, to) => { head = head.replace(re, to); };
  swap(/<title>[^<]*<\/title>/, `<title>${page.title}</title>`);
  swap(/(<meta name="description" content=")[^"]*(">)/, `$1${page.description}$2`);
  swap(/(<meta property="og:title" content=")[^"]*(">)/, `$1${page.ogTitle}$2`);
  swap(/(<meta property="og:description" content=")[^"]*(">)/, `$1${page.description}$2`);
  swap(/(<meta name="twitter:title" content=")[^"]*(">)/, `$1${page.ogTitle}$2`);
  swap(/(<meta name="twitter:description" content=")[^"]*(">)/, `$1${page.description}$2`);
  for (const attr of ['canonical', 'alternate']) {
    head = head.replace(new RegExp(`(<link rel="${attr}"[^>]*href="https://anystudio\\.ai)/("[^>]*>)`, 'g'), `$1${page.path === '/' ? '/' : page.path}$2`);
  }
  swap(/(<meta property="og:url" content="https:\/\/anystudio\.ai)\/(">)/, `$1${page.path === '/' ? '/' : page.path}$2`);
  // The organization/product structured data describes the whole product and
  // belongs on one page only; repeating it on subpages asserts three homepages.
  if (page.path !== '/') {
    head = head.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\n?/, '');
  }
  return head;
}

/** Anchors that only exist on the landing page must be absolute elsewhere. */
function resolveAnchors(html, onLanding) {
  for (const { id, path } of PROMOTED) html = html.split(`href="#${id}"`).join(`href="${path}"`);
  if (onLanding) return html;
  return html.replace(/href="#([a-z-]+)"/g, (_m, id) => (id === 'top' ? 'href="/"' : `href="/#${id}"`));
}

// ------------------------------------------------------------ the landing

const landingSrc = readFileSync(resolve(root, 'design/landing.html'), 'utf8');
const { head, nav, body, footer, script } = dissect(landingSrc);

const all = blocks(body);
const promoted = new Map();
const kept = [];
for (const block of all) {
  const hit = PROMOTED.find(({ id }) => block.includes(`<section class="sec" id="${id}">`));
  if (hit) promoted.set(hit.id, block);
  else kept.push(block);
}
for (const { id } of PROMOTED) {
  if (!promoted.has(id)) throw new Error(`design/landing.html has no <section id="${id}">`);
}

/** Renumber what is left, so the contact-sheet motif has no holes in it. */
let n = 0;
const landingBody = kept.join('\n').replace(/(class="mono num"[^>]*>)Frame \d+(<)/g,
  (_m, open, close) => `${open}Frame ${String(++n).padStart(2, '0')}${close}`);

/** A promoted section is no longer a frame of that sheet; it is the page. */
function standalone(id, label) {
  return promoted.get(id).replace(/(class="mono num"[^>]*>)Frame \d+(<)/, `$1${label}$2`);
}

const PAGES = [
  {
    path: '/', name: 'landing', symbol: 'LANDING', body: landingBody, keepAnchors: true,
    title: 'AnyStudio — Turn one product photo into posts, captions and reels',
    ogTitle: 'One product photo. Everything you post.',
    description: 'Send one phone photo on WhatsApp and get back branded product images, a written description and a short reel — ready to post. Three generations free, no card.',
  },
  {
    path: '/pricing', name: 'pricing', symbol: 'PRICING', body: standalone('pricing', 'Pricing'), keepAnchors: false,
    title: 'Pricing — AnyStudio',
    ogTitle: 'Pay for what you make. Nothing else.',
    description: 'Three generations free, no card. After that a plan or a one-off top-up, priced per market. Credits from top-ups never expire.',
  },
  {
    path: '/developers', name: 'developers', symbol: 'DEVELOPERS', body: standalone('api', 'For platforms'), keepAnchors: false,
    title: 'For platforms — AnyStudio',
    ogTitle: 'Content for every merchant, from one integration.',
    description: 'One API call turns a merchant’s phone photo into storefront-ready images and a description no other listing is using. Test keys work immediately, on 500 free credits.',
  },
];

for (const page of PAGES) {
  const doc = [headFor(head, page), resolveAnchors(nav, page.keepAnchors), page.body,
    resolveAnchors(footer, page.keepAnchors), script].join('\n');
  const html = rewriteLinks(rewriteAssets(wrap(doc)));
  writeFileSync(resolve(content, `${page.name}.ts`),
    `// GENERATED by scripts/sync-prototypes.mjs from design/landing.html — edit the prototype, not this file.\n` +
    `export const ${page.symbol}: string = ${JSON.stringify(html)};\n`);
  console.log(`✓ ${page.path.padEnd(12)} → apps/web/content/${page.name}.ts`);
}

// ------------------------------------------------------------------- org

const orgHtml = rewriteLinks(rewriteAssets(wrap(readFileSync(resolve(root, 'design/org.html'), 'utf8'))));
writeFileSync(resolve(content, 'org.ts'),
  `// GENERATED by scripts/sync-prototypes.mjs from design/org.html — edit the prototype, not this file.\n` +
  `export const ORG: string = ${JSON.stringify(orgHtml)};\n`);
console.log('✓ /org         → apps/web/content/org.ts');

// ------------------------------------------------------------------- seo

for (const f of ['favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'og-image.png',
  'site.webmanifest', 'llms.txt']) {
  copyFileSync(resolve(root, 'design/seo', f), resolve(pub, f));
}
writeFileSync(resolve(pub, 'robots.txt'),
  readFileSync(resolve(root, 'design/seo/robots.txt'), 'utf8').replace('Disallow: /signin', 'Disallow: /login'));

/** Only list what is live: a sitemap that 404s costs crawl budget and trust. */
const today = new Date().toISOString().slice(0, 10);
const urls = [['/', '1.0', 'weekly'], ['/pricing', '0.9', 'monthly'], ['/developers', '0.8', 'monthly'], ['/org', '0.7', 'monthly']];
writeFileSync(resolve(pub, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(([loc, pri, freq]) =>
    `  <url>\n    <loc>https://anystudio.ai${loc}</loc>\n    <lastmod>${today}</lastmod>\n` +
    `    <changefreq>${freq}</changefreq>\n    <priority>${pri}</priority>\n  </url>`).join('\n') +
  `\n</urlset>\n`);
console.log('✓ design/seo/* → apps/web/public/');
