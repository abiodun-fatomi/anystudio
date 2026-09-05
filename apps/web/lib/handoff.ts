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
export function followHandoff(url: string, next?: string | null, to?: string | null): void {
  const target = new URL(url);
  if (next && next.startsWith('/') && !next.startsWith('//')) target.searchParams.set('next', next);
  // The person came from the org host (its session had lapsed): the token
  // redeems on either portal host, so send them back through that door.
  if (to === 'org' && target.host.startsWith('app.')) target.host = `org.${target.host.slice(4)}`;
  window.location.assign(target.toString());
}
