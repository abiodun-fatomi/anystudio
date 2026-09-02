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
 */
import { NextResponse, type NextRequest } from 'next/server';

/** Paths that belong to the portal. Anything else on the marketing host is content. */
const APP_PREFIXES = ['/login', '/signup', '/forgot', '/reset', '/welcome', '/today', '/create', '/library',
  '/products', '/brand', '/publishing', '/insights', '/billing', '/settings', '/api'];

const isLocal = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? '';
  const { pathname, search } = req.nextUrl;

  // No host split locally: the landing is "/" and the portal is everything else.
  if (isLocal(host)) return NextResponse.next();

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
