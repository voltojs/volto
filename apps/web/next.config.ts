import type { NextConfig } from 'next';

// The exported build is plain files served by the gateway (or any static
// host), so it cannot own a rewrite table: `/gateway/*` only exists while
// `next dev` runs the dev proxy below. `pnpm build` (no env) keeps the
// current dev-loop behaviour; only an explicit export turns the app static.
const isExport = process.env.VOLTO_WEB_EXPORT === '1';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@volto/sdk', '@volto/i18n'],
  ...(isExport
    ? { output: 'export' as const, trailingSlash: true }
    : {
        async rewrites() {
          return [
            {
              source: '/gateway/:path*',
              destination: `${process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? 'http://localhost:3100'}/:path*`,
            },
          ];
        },
      }),
};

export default nextConfig;
