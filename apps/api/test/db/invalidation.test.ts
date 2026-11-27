import { createHmac, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect } from '../../../../packages/db/src/client.ts';
import { requireWritable, rows } from '../../../../packages/db/test/fixtures.ts';
import type {} from '../../../../packages/db/test/setup.ts';
import type { Env } from '../../src/shell.ts';

const { appUrl, authUrl, ownerUrl } = inject('db');
const people = ['oona', 'quinn'] as const;
const emailOf = (name: string) => `${name}.inv@example.test`;
vi.stubEnv('DATABASE_URL', appUrl);
vi.stubEnv('AUTH_DATABASE_URL', authUrl);
vi.stubEnv('SIGNUP_ALLOWLIST', people.map(emailOf).join(','));
const { default: api } = await import('../../src/index.ts');
const { invalidate } = await import('../../src/middleware/invalidate.ts');

const auth = connect(authUrl);
const owner = connect(ownerUrl);
const asOwnerRole = rows(drizzle(owner));
const secret = process.env.REVALIDATE_SECRET ?? '';
const cookies: Record<string, string> = {};
const realFetch = globalThis.fetch;
const job = { company: 'Northwind', role: 'Lead', location: '', startsOn: '2022-03-01' };
const projects = '/api/v1/me/projects';
const ledger = { name: 'Ledger', description: 'One ledger.', url: null, repoUrl: null, tags: [] };
let calls: { url: string; tags: string[]; signed: boolean }[] = [];
let answer = async () => new Response(null, { status: 204 });

function send(method: string, path: string, body?: unknown, headers = {}) {
  return api.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3200',
      'idempotency-key': randomUUID(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
const as = (name: string, method: string, path: string, body?: unknown, headers = {}) =>
  send(method, path, body, { cookie: cookies[name], ...headers });

beforeAll(async () => {
  requireWritable();
  for (const [i, name] of people.entries()) {
    for (const step of ['sign-up', 'sign-in']) {
      const user = { name: 'Fixture Person', email: emailOf(name), password: 'pw-inv-7' };
      const res = await send('POST', `/api/auth/${step}/email`, user, {
        'x-forwarded-for': `203.0.113.${181 + i}`,
      });
      expect(res.status).toBe(200);
      const cookie = res.headers.getSetCookie().find((line) => line.startsWith('better-auth.'));
      cookies[name] = cookie?.split(';')[0] ?? '';
    }
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.endsWith('/revalidate')) return realFetch(input, init);
    const body = String(init?.body);
    const [, t, v1] = /^t=(\d+),v1=(\w+)$/.exec(
      new Headers(init?.headers).get('x-fancyfolio-signature') ?? '',
    ) ?? ['', '', ''];
    const signed = v1 === createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    calls.push({ url, tags: JSON.parse(body).tags, signed });
    return answer();
  });
});

afterEach(() => {
  calls = [];
  answer = async () => new Response(null, { status: 204 });
});

afterAll(async () => {
  vi.restoreAllMocks();
  const query = rows(drizzle(auth));
  await query(sql`delete from users where email like '%.inv@example.test'`);
  await query(sql`delete from rate_limits where key like '203.0.113.18_|%'`);
  await Promise.all([auth.end(), owner.end()]);
});

function expectOneCall(res: Response, status: number, tags: string[]) {
  expect([res.status, res.headers.get('x-revalidated')]).toEqual([status, 'true']);
  expect(calls).toEqual([{ url: 'http://127.0.0.1:1/revalidate', tags, signed: true }]);
  calls = [];
}

describe('the invalidation of every mutating /api/v1 route', () => {
  it('sends one signed revalidation after each 2xx write: the site and tenant on onboarding, the tenant on every other route', async () => {
    const onboarded = await as('oona', 'POST', '/api/v1/tenants', { subdomain: 'oona-inv' });
    const tenant = `tenant:${(await onboarded.json()).id}`;
    expectOneCall(onboarded, 201, [tenant, 'site:oona-inv']);
    const covered = new Set(['POST /api/v1/tenants']);
    const write = async (method: string, path: string, body: unknown, status = 200) => {
      covered.add(`${method} ${path.replace(/\/[0-9a-f-]{36}$/, '/:id')}`);
      const res = await as('oona', method, path, body);
      const saved = await res.json();
      expectOneCall(res, status, [tenant]);
      return saved;
    };
    const profile = await (await as('oona', 'GET', '/api/v1/me/profile')).json();
    await write('PUT', '/api/v1/me/profile', { ...profile, avatarUrl: undefined });
    for (const [base, body] of [
      ['/api/v1/me/experiences', { ...job, endsOn: null, summaryMd: '' }],
      [projects, ledger],
    ] as const) {
      const created = await write('POST', base, body, 201);
      const item = `${base}/${created.id}`;
      const saved = await write('PUT', item, { ...body, updatedAt: created.updatedAt });
      await write('DELETE', item, { updatedAt: saved.updatedAt });
    }
    const exempt = ['POST /api/v1/rooms/auth', 'POST /api/v1/rooms/seed'];
    const mutating = api.routes
      .filter((route) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method))
      .map((route) => `${route.method} ${route.path}`)
      .filter((route) => route.includes(' /api/v1/') && !exempt.includes(route));
    expect(covered).toEqual(new Set(mutating));
  });

  it('sends nothing and sets no header for refusals, reads and a 2xx write that recorded no tags', async () => {
    const created = await (await as('oona', 'POST', projects, ledger)).json();
    const untagged = new Hono<Env>().use(invalidate).post('/', (c) => c.body(null, 204));
    const foreign = { 'content-type': 'text/plain', origin: 'https://evil.example' };
    const stale = { ...ledger, updatedAt: '2020-01-01 00:00:00+00' };
    calls = [];
    for (const [pending, status] of [
      [send('PUT', '/api/v1/me/profile', {}), 401],
      [as('oona', 'POST', projects, 'x', foreign), 403],
      [as('oona', 'POST', projects, { name: '' }), 400],
      [as('oona', 'PUT', `${projects}/${created.id}`, stale), 409],
      [as('oona', 'DELETE', `${projects}/${randomUUID()}`, { updatedAt: created.updatedAt }), 404],
      [as('quinn', 'POST', projects, ledger), 404],
      [as('quinn', 'POST', '/api/v1/tenants', { subdomain: 'oona-inv' }), 409],
      [as('oona', 'GET', '/api/v1/me'), 200],
      [as('oona', 'GET', projects), 200],
      [untagged.request('/', { method: 'POST' }), 204],
    ] as const) {
      const res = await pending;
      expect([res.status, res.headers.get('x-revalidated')]).toEqual([status, null]);
    }
    expect(calls).toEqual([]);
  });

  it('keeps the committed write and answers x-revalidated: false after two attempts when the web is unreachable', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = randomUUID();
    const rowsAtCall: unknown[] = [];
    answer = async () => {
      rowsAtCall.push(await asOwnerRole(sql`select name from projects where id = ${id}`));
      return Promise.reject(new TypeError('fetch failed'));
    };
    const res = await as('oona', 'POST', projects, ledger, { 'idempotency-key': id });
    expect([res.status, res.headers.get('x-revalidated')]).toEqual([201, 'false']);
    expect(rowsAtCall).toEqual([[{ name: 'Ledger' }], [{ name: 'Ledger' }]]);
    expect([...res.headers.keys()].sort()).toEqual([
      'cache-control',
      'content-security-policy',
      'content-type',
      'x-content-type-options',
      'x-request-id',
      'x-revalidated',
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).not.toContain(secret);
  });
});
