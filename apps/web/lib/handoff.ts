/**
 * Finishing a sign-in that happened on the marketing host.
 *
 * The sign-in and sign-up pages live on the marketing hostname
 * (`dev.anystudio.ai`), but the session cookie is __Host- scoped to the app
 * hostname (`app.dev.anystudio.ai`) — only that host can set it. So the API
 * answers a marketing-host sign-in with a one-time URL on the app host; the
 * browser goes there, the page there redeems the token, and the session is
 * minted where it will be read. A full navigation, not a router push: the
 * hostname changes.
 */
export function followHandoff(url: string, next?: string | null): void {
  const target = new URL(url);
  if (next && next.startsWith('/') && !next.startsWith('//')) target.searchParams.set('next', next);
  window.location.assign(target.toString());
}
