import { errorBody } from '@fancyfolio/contracts';
import { Hono } from 'hono';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.ts';
import { type Env, onError, shell } from '../src/shell.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

function expectShellHeaders(res: Response): string {
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
  const requestId = res.headers.get('x-request-id') ?? '';
  expect(requestId).toMatch(uuid);
  return requestId;
}

describe('every response', () => {
  it('carries no-store, nosniff, the CSP and a request id on a route the app serves', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expectShellHeaders(res);
  });

  it.each([
    ['GET', '/api/nope'],
    ['GET', '/favicon.ico'],
    ['GET', '/'],
    ['POST', '/api/health'],
    ['DELETE', '/api/health'],
    ['GET', '/api/nope%0D%0ASet-Cookie:%20a=b'],
    ['GET', '/api/health%0A'],
    ['GET', '/%0A'],
    ['GET', '/api/%68ealth'],
  ])('answers %s %s with a JSON 404 that names only the request id', async (method, path) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('set-cookie')).toBeNull();
    const requestId = expectShellHeaders(res);
    expect(await res.json()).toEqual({ error: 'Not found', requestId });
  });

  it('gets a fresh request id per request, never one the caller sent', async () => {
    const [first, second] = await Promise.all([
      app.request('/api/health', { headers: { 'x-request-id': 'caller-chosen-id' } }),
      app.request('/api/health'),
    ]);
    const ids = [expectShellHeaders(first), expectShellHeaders(second)];
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids).not.toContain('caller-chosen-id');
  });
});

describe('an internal error', () => {
  const secret = 'leaky-param-marker';
  const failing = new Hono<Env>()
    .use(shell)
    .onError(onError)
    .get('/boom', () => {
      throw new Error(`Failed query: select * from users where token = $1\nparams: ${secret}`, {
        cause: Object.assign(new Error('relation missing'), { code: '42P01' }),
      });
    });

  it('answers a generic body with the request id and no stack, SQL, path or detail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await failing.request('/boom');
    expect(res.status).toBe(500);
    const requestId = expectShellHeaders(res);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'Internal error', requestId });
    expect(v.is(errorBody, JSON.parse(text))).toBe(true);
    for (const leak of [secret, 'select', 'users', '42P01', 'at ', '/test/', '.ts']) {
      expect(text).not.toContain(leak);
    }
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({
      requestId,
      method: 'GET',
      path: '/boom',
      error: 'Error',
      code: '42P01',
    });
    expect(JSON.parse(line).stack[0]).toMatch(/^\s*at /);
    expect(line).not.toContain(secret);
  });
});

describe('a thrown value the error handler cannot read', () => {
  const cyclic = new Error('cyclic');
  cyclic.cause = cyclic;
  const throwingCause = Object.defineProperty(new Error('getter'), 'cause', {
    get() {
      throw new Error('cause getter');
    },
  });
  const numericStack = Object.assign(new Error('stack'), { stack: 42 });

  it.each<[string, unknown, Record<string, unknown>]>([
    ['a cyclic cause', cyclic, { error: 'Error', stack: expect.any(Array) }],
    ['a throwing cause getter', throwingCause, { error: 'unreadable thrown value' }],
    ['a non-string stack', numericStack, { error: 'Error' }],
    ['a thrown string', 'thrown-string-marker', { error: 'string' }],
    [
      'a thrown plain object',
      { code: 'XX000', detail: 'thrown-object-marker' },
      { error: 'object', code: 'XX000' },
    ],
  ])(
    'still answers %s with the generic 500 and every shell header',
    async (_name, thrown, logged) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failing = new Hono<Env>()
        .use(shell)
        .onError(onError)
        .get('/boom', () => {
          throw thrown;
        });
      const res = await failing.request('/boom');
      expect(res.status).toBe(500);
      const requestId = expectShellHeaders(res);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'Internal error', requestId });
      expect(text).not.toContain('marker');
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
        requestId,
        method: 'GET',
        path: '/boom',
        ...logged,
      });
    },
  );
});
