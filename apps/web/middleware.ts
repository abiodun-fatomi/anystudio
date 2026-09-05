/**
 * Host routing. One deployment, two hostnames per environment:
 *
 *   anystudio.ai        (dev.anystudio.ai / staging.anystudio.ai)  — marketing
 *   app.anystudio.ai    (app.dev… / app.staging…)                  — the portal, businesses
 *   org.anystudio.ai    (org.dev… / org.staging…)                  — the portal, organizations
 *
 * app. and org. are the same pages; only the session differs. A __Host-
 * cookie set on one is invisible to the other, so moving a person between
 * them is a one-time hand-off (lib/app-context.tsx decides when).
 *
 * The marketing host serves the landing, pricing, developer and organization
 * pages (route handlers returning the finished documents) and the sign-in
 * pages, and bounces every app route across to the app host. The app host
 * does the reverse: it is for people who are signed in. It has no landing —
 * "/" goes straight to Today, and Today's own auth check sends a signed-out
 * visitor to the marketing host's /login. Cookies are __Host- scoped, so
 * nothing set on one hostname is visible on the other; a sign-in on the
 * marketing host therefore ends with a one-time hop to /auth/handoff on the
 * app host, where the session cookie is minted.
 *
 * On localhost there is no host split; everything is reachable on one origin.
 *
 * Nothing here is configured per environment. The API and admin hostnames
 * are derived from the request's own hostname, which is why one build of
 * this app deploys unchanged to development, staging and production.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { baseHost, isLocalHost, siblingOrigin } from '@/lib/hosts';

/** The marketing pages. On the app host these belong to the other hostname. */
const MARKETING_PATHS = ['/', '/org', '/pricing', '/developers'];

/**
 * The sign-in pages. They live on the marketing host — `app.` is for people
 * who are signed in — and finish on the app host through /auth/handoff, which
 * is where the session cookie can be set. The admin host keeps its own.
 */
const AUTH_PATHS = ['/login', '/signup', '/forgot', '/reset'];

/** Paths that belong to the portal. Anything else on the marketing host is content. */
const APP_PREFIXES = [
  '/auth',
  '/verify',
  '/email-change',
  '/invite',
  '/welcome',
  '/today',
  '/studio',
  '/create',
  '/library',
  '/products',
  '/brand',
  '/publishing',
  '/insights',
  '/developer',
  '/notifications',
  '/billing',
  '/settings',
  '/api',
];

/**
 * API routes whose answer is a redirect the BROWSER must follow. A rewrite
 * follows redirects itself and serves whatever is at the far end under our
 * URL — for the Google handshake that meant Google's sign-in page rendered
 * on app.<base>, where nothing on it could work. These are proxied by hand
 * with redirects left alone, so the Location and Set-Cookie reach the browser.
 */
const NAVIGATION_API_PATHS = ['/api/v1/auth/google/start', '/api/v1/auth/google/callback'];

export async function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? '';
  const { pathname, search } = req.nextUrl;

  // Same-origin API: /api/* is proxied to this environment's API host, so
  // cookies stay first-party and there is no CORS preflight. The target is
  // derived from the hostname (lib/hosts.ts), not configured anywhere.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    // The API owns the /api/v1/... prefix itself, so the path passes through unchanged.
    const target = new URL(pathname, siblingOrigin(host, 'api'));
    target.search = search;
    // The API sees this host as its own once the rewrite lands, so tell it
    // where the browser really is. Origin and Referer are absent on a
    // top-level navigation — which is exactly what the OAuth handshake is —
    // and the API needs the public origin to build its redirect_uri and to
    // decide which surface the request belongs to.
    const headers = new Headers(req.headers);
    headers.set('x-anystudio-origin', `${req.nextUrl.protocol}//${host}`);
    // Where the browser is, as Cloudflare saw it — a fallback the API uses
    // to price an account that has no phone number to go by.
    const country = req.headers.get('cf-ipcountry');
    if (country) headers.set('x-anystudio-country', country);
    if (NAVIGATION_API_PATHS.includes(pathname)) return passThroughRedirect(target, headers, req.nextUrl);
    return NextResponse.rewrite(target, { request: { headers } });
  }

  // No host split locally: the landing is "/" and the portal is everything else.
  if (isLocalHost(host)) return NextResponse.next();

  // www → apex, permanently. One canonical host per environment.
  if (host.startsWith('www.')) {
    return NextResponse.redirect(`https://${host.slice(4)}${pathname}${search}`, 308);
  }

  const onApp = host.startsWith('app.') || host.startsWith('org.');
  const onAdmin = host.startsWith('admin.');

  // The staff console: its own hostname (so its session cookie is its own),
  // the same build. Only the console's routes and the sign-in pages answer here.
  if (onAdmin) {
    if (pathname === '/') return NextResponse.redirect(new URL('/admin', req.url), 307);
    if (pathname === '/login' && !req.nextUrl.searchParams.get('next')) return NextResponse.redirect(new URL('/login?next=/admin', req.url), 307);
    if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/login' || pathname === '/forgot' || pathname === '/reset')
      return NextResponse.next();
    return NextResponse.redirect(new URL('/admin', req.url), 307);
  }
  // The console reached on any other host belongs on its own.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return NextResponse.redirect(`https://admin.${baseHost(host)}${pathname}${search}`, 307);
  }

  if (onApp) {
    // The portal has no landing: "/" goes to Today, and Today's own auth check
    // sends a signed-out visitor to /login.
    if (pathname === '/') return NextResponse.redirect(new URL('/today', req.url), 307);
    // A marketing page reached on the app host belongs on the marketing one —
    // otherwise the same content answers on two hostnames and splits its own
    // search ranking.
    if (MARKETING_PATHS.includes(pathname) || AUTH_PATHS.includes(pathname)) {
      return NextResponse.redirect(`https://${baseHost(host)}${pathname}${search}`, 307);
    }
    return NextResponse.next();
  }

  // Marketing host from here on. The marketing paths are real routes
  // (app/route.ts, app/org/route.ts, …); the portal's are bounced across.
  if (APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.redirect(`https://app.${host}${pathname}${search}`, 307);
  }

  return NextResponse.next();
}

/**
 * Fetch an API route on the browser's behalf without following redirects,
 * and hand its answer back verbatim: status, Location, every Set-Cookie.
 * The Location is a path on this host (the callback's landing page) or an
 * absolute URL elsewhere (Google's consent screen); the browser resolves
 * both correctly because the response carries our URL.
 */
async function passThroughRedirect(target: URL, headers: Headers, self: URL): Promise<NextResponse> {
  headers.delete('host');
  const upstream = await fetch(target, { method: 'GET', headers, redirect: 'manual' });
  const out = new Headers();
  for (const name of ['content-type', 'cache-control']) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  // A relative Location (the callback's "/welcome") is resolved against this
  // host: the runtime insists on an absolute one, and absolute is what the
  // browser would have computed anyway.
  const location = upstream.headers.get('location');
  if (location) out.set('location', new URL(location, self.origin).toString());
  // Several Set-Cookie headers must stay several; joining them breaks every one.
  const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  for (const c of cookies) out.append('set-cookie', c);
  const redirect = upstream.status >= 300 && upstream.status < 400;
  return new NextResponse(redirect ? null : upstream.body, { status: upstream.status, headers: out });
}

export const config = {
  // Everything except Next internals and files with an extension (images,
  // the static pages themselves, robots.txt…), which the asset layer serves.
  matcher: ['/((?!_next/|.*\\..*).*)'],
};
