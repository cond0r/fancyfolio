import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.ts';

const hostileValues = [
  '',
  'Ines',
  'xn--ines',
  'ines.example.',
  'ines.example:443',
  '../health',
  '%2e%2e%2fhealth',
  'ines\r\nSet-Cookie: a=b',
  'ines\u0000',
  'ines\u001b[31m',
  "' OR '1'='1",
  "ines'; drop table tenants; --",
  'іnes',
  'ｉｎｅｓ',
  'a'.repeat(10_240),
  '__proto__',
  '127.0.0.1',
];

const rawPaths = [
  '/api/v1/sites/%E0%A4%A',
  '/api/v1/sites/%252e%252e',
  '/api/v1/sites/ines%2Fcase-studies%2Fx',
  '/api/v1/sites/ines/case-studies/%E0%A4%A',
  '/api/v1/sites/ines/case-studies/..%2f..%2fhealth',
  '/api/v1/sites/ines/case-studies',
  '/api/v1/sites/ines/case-studies/a/b',
];

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectNotFoundBeforeTheDatabase(path: string) {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const res = await app.request(path);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: 'Not found',
    requestId: res.headers.get('x-request-id'),
  });
  expect(log).not.toHaveBeenCalled();
}

describe('the public site routes refuse malformed path values before any database access', () => {
  it.each([...hostileValues, 'admin', 'www'])('site key %j gives 404', async (value) => {
    await expectNotFoundBeforeTheDatabase(`/api/v1/sites/${encodeURIComponent(value)}`);
  });

  it.each(hostileValues)('case-study slug %j gives 404', async (value) => {
    await expectNotFoundBeforeTheDatabase(
      `/api/v1/sites/ines/case-studies/${encodeURIComponent(value)}`,
    );
  });

  it.each(rawPaths)('raw path %s gives 404', async (path) => {
    await expectNotFoundBeforeTheDatabase(path);
  });
});

describe('a public read while the database is unreachable', () => {
  it.each(['/api/v1/sites/ines', '/api/v1/sites/ines/case-studies/billing-rewrite'])(
    '%s answers the generic 500 and logs the cause without the connection secret',
    async (path) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await app.request(path);
      expect(res.status).toBe(500);
      const requestId = res.headers.get('x-request-id');
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'Internal error', requestId });
      for (const leak of ['ECONNREFUSED', '127.0.0.1', 'unused-password-Z7', 'ff_app', 'at ']) {
        expect(text).not.toContain(leak);
      }
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0][0]);
      expect(JSON.parse(line)).toMatchObject({
        requestId,
        method: 'GET',
        path,
        code: 'ECONNREFUSED',
      });
      expect(line).not.toContain('unused-password-Z7');
    },
  );
});
