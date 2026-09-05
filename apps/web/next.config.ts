import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

// Lets `next dev` see Cloudflare bindings and `vars` from wrangler.jsonc.
// A no-op in `next build`, and outside a Cloudflare project.
initOpenNextCloudflareForDev();

/**
 * No environment-specific values here. The API proxy (/api/*) lives in
 * middleware.ts and derives its target from the request host, so the same
 * build runs in every environment.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@anystudio/shared'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self "https://*.paddle.com")' },
        ],
      },
    ];
  },
};
export default config;
