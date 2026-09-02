/**
 * Serve a finished static document from a Route Handler.
 *
 * The marketing pages are complete HTML files (design/*.html, mirrored into
 * content/ by scripts/sync-prototypes.mjs). Rebuilding them as React would be
 * weeks of work for no user-visible gain, and a rewrite to a file in public/
 * is not honoured by the Cloudflare adapter — so a handler returns the
 * document itself. Short edge cache: the page changes with a deploy, not
 * with a request.
 */
export function staticPage(html: string): Response {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
    },
  });
}
