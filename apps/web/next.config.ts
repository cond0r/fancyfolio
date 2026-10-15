import type { NextConfig } from 'next';
import { env } from './env.ts';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  typedRoutes: true,
  reactCompiler: true,
  transpilePackages: ['@fancyfolio/contracts'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        has: [{ type: 'host', value: env.ROOT_DOMAIN.replaceAll('.', '\\.') }],
        destination: `${env.API_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
