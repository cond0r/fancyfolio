import { expect, test } from '@playwright/test';

const securityHeaders = {
  'content-security-policy': expect.stringContaining("object-src 'none'; base-uri 'none'"),
  'strict-transport-security': 'max-age=63072000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

test.describe('the proxy behind vercel dev', () => {
  for (const [host, path, status, location] of [
    ['localhost:3200', '/', 200, undefined],
    ['WWW.localhost:3200', '/about?x=1', 308, 'http://localhost:3200/about?x=1'],
    ['localhost:3200', '/sites/ines', 404, undefined],
    ['localhost:3200', '/%73ites/ines', 404, undefined],
    ['localhost:3200', '//sites/ines', 404, undefined],
    ['api.localhost:3200', '/', 404, undefined],
    ['a.b.localhost:3200', '/', 404, undefined],
    ['ines.localhost:3200', '/%2e%2e/dashboard', 404, undefined],
  ] as const) {
    test(`answers ${status} with the security headers for ${path} on ${host}`, async ({
      request,
    }) => {
      const res = await request.get(`http://localhost:3200${path}`, {
        headers: { 'x-forwarded-host': host },
        maxRedirects: path === '//sites/ines' ? 1 : 0,
      });
      expect(res.status()).toBe(status);
      expect(res.headers()).toMatchObject(securityHeaders);
      expect(res.headers().location).toBe(location);
    });
  }
});

test('the API answers 404 on a tenant host', async ({ request }) => {
  const res = await request.get('http://localhost:3200/api/health', {
    headers: { 'x-forwarded-host': 'ines.localhost:3200' },
  });
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ error: 'Not found', requestId: expect.any(String) });
});
