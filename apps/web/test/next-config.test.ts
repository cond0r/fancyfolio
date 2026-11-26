import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../next.config.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('next.config.ts', () => {
  it('turns on Cache Components, Partial Prefetching, typed routes and the React Compiler', () => {
    expect(config).toMatchObject({
      cacheComponents: true,
      partialPrefetching: true,
      typedRoutes: true,
      reactCompiler: true,
    });
  });

  it('sends the security headers on every path, with no unsafe-eval outside development', async () => {
    expect(await config.headers?.()).toEqual([
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]);
    vi.stubEnv('NODE_ENV', 'development');
    const [{ headers }] = (await config.headers?.()) ?? [];
    expect(headers[0].value).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval';");
  });

  it.each([
    ['http://localhost:1153', "connect-src 'self' http://localhost:1153 ws://localhost:1153"],
    [
      'https://rooms.example.test/v2',
      "connect-src 'self' https://rooms.example.test wss://rooms.example.test",
    ],
  ])('lets the browser reach the Liveblocks server at %s', async (url, connect) => {
    vi.stubEnv('NEXT_PUBLIC_LIVEBLOCKS_BASE_URL', url);
    const [{ headers }] = (await config.headers?.()) ?? [];
    expect(headers[0].value).toContain(`; ${connect}`);
  });

  it('refuses a Liveblocks server URL that is not http(s)', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIVEBLOCKS_BASE_URL', 'javascript:alert(1); script-src *');
    await expect(config.headers?.()).rejects.toThrow('Invalid environment');
  });
});
