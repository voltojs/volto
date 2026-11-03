import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@volto/sdk', '@volto/i18n'],
  async rewrites() {
    return [
      {
        source: '/gateway/:path*',
        destination: `${process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? 'http://localhost:3100'}/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
