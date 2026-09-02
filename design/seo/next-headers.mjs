/**
 * AnyStudio — HTTP security headers.
 *
 * Spread SECURITY_HEADERS into next.config.mjs:
 *
 *   import { SECURITY_HEADERS, AUTH_HEADERS } from "./security/next-headers.mjs";
 *   const nextConfig = {
 *     poweredByHeader: false,           // stops advertising the framework version
 *     async headers() {
 *       return [
 *         { source: "/:path*", headers: SECURITY_HEADERS },
 *         { source: "/(signin|signup|forgot|reset)", headers: AUTH_HEADERS },
 *       ];
 *     },
 *   };
 *
 * A <meta http-equiv> tag cannot substitute for most of these — browsers only
 * honour CSP, HSTS, COOP, CORP and X-Content-Type-Options as real response
 * headers. Verify what you actually ship with:  curl -sI https://anystudio.ai
 */

const isProd = process.env.NODE_ENV === "production";

/**
 * Content-Security-Policy.
 *
 * 'strict-dynamic' with a per-request nonce is the target. Next.js supports it
 * through middleware: generate a nonce, put it on this header and on the script
 * tags. Until that middleware exists, the dev-only allowances below are what a
 * Next.js dev server needs — they must never reach production, because
 * 'unsafe-inline' on script-src defeats the entire policy.
 *
 * Every host listed here is one AnyStudio genuinely talks to. Adding a host is
 * a decision, not a formality: a CDN on script-src can execute code as you.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",              // clickjacking: nothing may frame us
  "form-action 'self'",                  // a stolen form cannot post elsewhere
  "script-src 'self' 'strict-dynamic' https:" + (isProd ? "" : " 'unsafe-inline' 'unsafe-eval'"),
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://cdn.anystudio.ai https://*.r2.cloudflarestorage.com",
  "media-src 'self' blob: https://cdn.anystudio.ai https://*.r2.cloudflarestorage.com",
  "connect-src 'self' https://api.anystudio.ai https://*.supabase.co wss://*.supabase.co https://app.posthog.com https://api.flutterwave.com https://checkout.paddle.com",
  "frame-src https://checkout.paddle.com https://checkout.flutterwave.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
  "report-uri /api/csp-report",
  "report-to csp",
].join("; ");

export const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },

  // Two years, subdomains included, preload-list eligible. Only keep `preload`
  // once you are certain every subdomain will be HTTPS forever — removal from
  // the preload list takes months to propagate.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },

  // Never let a browser guess a response's type — that is how a file a user
  // uploaded as an "image" ends up executed as a script.
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Legacy twin of frame-ancestors, for browsers that predate CSP level 2.
  { key: "X-Frame-Options", value: "DENY" },

  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // Nothing here needs a camera, a microphone or a location. Denying them up
  // front means a compromised third-party script cannot even ask.
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()", "autoplay=(self)", "camera=()", "display-capture=()",
      "encrypted-media=()", "fullscreen=(self)", "geolocation=()", "gyroscope=()",
      "magnetometer=()", "microphone=()", "midi=()", "payment=(self)",
      "picture-in-picture=()", "publickey-credentials-get=(self)",
      "screen-wake-lock=()", "usb=()", "xr-spatial-tracking=()",
      "interest-cohort=()",
    ].join(", "),
  },

  // Cross-origin isolation: keeps other origins out of our window and our
  // resources out of theirs. credentialless rather than require-corp, so
  // third-party images still load without CORP headers of their own.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },

  { key: "Origin-Agent-Cluster", value: "?1" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },

  {
    key: "Report-To",
    value: JSON.stringify({
      group: "csp",
      max_age: 10886400,
      endpoints: [{ url: "https://anystudio.ai/api/csp-report" }],
    }),
  },
];

/** Auth routes: never cached, never framed, never referred from, never indexed. */
export const AUTH_HEADERS = [
  ...SECURITY_HEADERS,
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" },
  { key: "Pragma", value: "no-cache" },
  // A password reset token travels in the URL; no referrer must ever carry it.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
];

/** Immutable static assets — hashed filenames only. */
export const ASSET_HEADERS = [
  { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
  { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
];
