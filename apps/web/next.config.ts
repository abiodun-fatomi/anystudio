import type { NextConfig } from 'next';

/**
 * Same-origin API in the browser: /api/* is rewritten to the NestJS service, so
 * cookies are first-party and no CORS preflight happens for the app's own
 * calls. The public org API stays on api.anystudio.ai and is never proxied.
 */
const API = process.env.API_ORIGIN ?? 'http://localhost:3001';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@anystudio/shared'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/:path*` }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self)' },
      ],
    }];
  },
};
export default config;
