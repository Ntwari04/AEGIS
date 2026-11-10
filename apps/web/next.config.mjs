import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
export default {
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  output: 'standalone',
  poweredByHeader: false,
  transpilePackages: ['@aegisops/shared-types'],
  async headers() {
    // The Content-Security-Policy is NOT here: it needs a fresh nonce per request, so src/middleware.ts sets it (see lib/csp.ts).
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    }];
  },
};
