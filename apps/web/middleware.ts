/**
 * Host routing. One deployment, two hostnames per environment:
 *
 *   anystudio.ai        (dev.anystudio.ai / staging.anystudio.ai)  — marketing
 *   app.anystudio.ai    (app.dev… / app.staging…)                  — the portal
 *
 * The marketing host serves the landing and organization pages (route
 * handlers returning the finished documents) and bounces every app route
 * across to the app host. The app host has no
 * landing: "/" goes straight to Today, and Today's own auth check sends a
 * signed-out visitor to /login. Cookies are __Host- scoped, so nothing set
 * on one hostname is visible on the other — the split costs nothing.
 *
 * On localhost there is no host split; everything is reachable on one origin.
 *
 * Nothing here is configured per environment. The API and admin hostnames
 * are derived from the request's own hostname, which is why one build of
 * this app deploys unchanged to development, staging and production.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isLocalHost, siblingOrigin } from '@/lib/hosts';

/** Paths that belong to the portal. Anything else on the marketing host is content. */
const APP_PREFIXES = ['/login', '/signup', '/forgot', '/reset', '/welcome', '/today', '/create', '/library',
  '/products', '/brand', '/publishing', '/insights', '/billing', '/settings', '/api'];

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? '';
  const { pathname, search } = req.nextUrl;

  // Same-origin API: /api/* is proxied to this environment's API host, so
  // cookies stay first-party and there is no CORS preflight. The target is
  // derived from the hostname (lib/hosts.ts), not configured anywhere.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const target = new URL(pathname.slice(4) || '/', siblingOrigin(host, 'api'));
    target.search = search;
    return NextResponse.rewrite(target);
  }

  // No host split locally: the landing is "/" and the portal is everything else.
  if (isLocalHost(host)) return NextResponse.next();

  // www → apex, permanently. One canonical host per environment.
  if (host.startsWith('www.')) {
    return NextResponse.redirect(`https://${host.slice(4)}${pathname}${search}`, 308);
  }

  const onApp = host.startsWith('app.');

  if (onApp) {
    if (pathname === '/') return NextResponse.redirect(new URL('/today', req.url), 307);
    return NextResponse.next();
  }

  // Marketing host from here on. "/" and "/org" are real routes (app/route.ts,
  // app/org/route.ts); the portal's routes are bounced to the app host.
  if (APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.redirect(`https://app.${host}${pathname}${search}`, 307);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and files with an extension (images,
  // the static pages themselves, robots.txt…), which the asset layer serves.
  matcher: ['/((?!_next/|.*\\..*).*)'],
};
