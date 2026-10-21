import { errorBody } from '@fancyfolio/contracts';
import { Hono } from 'hono';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db.ts';
import app from '../src/index.ts';
import { type Env, onError, shell } from '../src/shell.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  const numericMessage = Object.assign(new Error('message'), { message: 42, code: 'XX000' });
  const throwingMessage = new Error('message');
  // V8 formats a stack on first read through the message, so read it before the getter exists.
  void throwingMessage.stack;
  Object.defineProperty(throwingMessage, 'message', {
    get() {
      throw new Error('message getter');
    },
  });

  it.each<[string, unknown, Record<string, unknown>]>([
    ['a cyclic cause', cyclic, { error: 'Error', stack: expect.any(Array) }],
    ['a throwing cause getter', throwingCause, { error: 'unreadable thrown value' }],
    ['a non-string stack', numericStack, { error: 'Error' }],
    [
      'a non-string message',
      numericMessage,
      { error: 'Error', code: 'XX000', stack: expect.any(Array) },
    ],
    ['a throwing message getter', throwingMessage, { error: 'Error', stack: expect.any(Array) }],
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

describe('a configuration error', () => {
  const failing = (thrown: () => unknown) =>
    new Hono<Env>()
      .use(shell)
      .onError(onError)
      .get('/boom', async () => {
        await thrown();
        return new Response(null, { status: 204 });
      });

  async function logged(thrown: () => unknown): Promise<string> {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await failing(thrown).request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error', requestId: expect.any(String) });
    expect(log).toHaveBeenCalledTimes(1);
    return String(log.mock.calls[0][0]);
  }

  it('logs which variable is missing when the database is opened without DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    const line = await logged(() => db.withTenant({ kind: 'job' }, async () => null));
    expect(JSON.parse(line)).toMatchObject({
      error: 'Error',
      message: 'Invalid environment: DATABASE_URL (missing)',
    });
  });

  it('logs no part of a malformed database URL', async () => {
    vi.stubEnv(
      'DATABASE_URL',
      'postgres://leaky_user:leaky-password-Q9@leaky-host.example.test:5432/db?sslmode=require',
    );
    const line = await logged(() => db.withTenant({ kind: 'job' }, async () => null));
    expect(JSON.parse(line)).not.toHaveProperty('message');
    for (const leak of ['leaky', 'password', 'sslmode', 'postgres://']) {
      expect(line).not.toContain(leak);
    }
  });

  it('logs only the dot paths of a schema error, never the values it rejected', async () => {
    const schema = v.object({
      profile: v.object({ name: v.string(), links: v.array(v.string()) }),
    });
    const line = await logged(() =>
      v.parse(schema, { profile: { name: ['leaky-value-marker'], links: ['ok', 424242] } }),
    );
    expect(JSON.parse(line)).toMatchObject({
      error: 'ValiError',
      paths: ['profile.name', 'profile.links.1'],
    });
    expect(JSON.parse(line)).not.toHaveProperty('message');
    expect(line).not.toContain('leaky');
    expect(line).not.toContain('424242');
  });
});
