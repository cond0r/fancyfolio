import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect } from '../../../../packages/db/src/client.ts';
import { createTenant, requireWritable, rows } from '../../../../packages/db/test/fixtures.ts';
import type {} from '../../../../packages/db/test/setup.ts';

const { appUrl, authUrl } = inject('db');
const appOrigin = 'http://localhost:3200';
const password = 'correct-horse-battery-7';
vi.stubEnv('DATABASE_URL', appUrl);
vi.stubEnv('AUTH_DATABASE_URL', authUrl);
vi.stubEnv('SIGNUP_ALLOWLIST', 'amara.me@example.test,kenji.me@example.test');
const { default: api } = await import('../../src/index.ts');

const auth = connect(authUrl);
const app = connect(appUrl);
const amara = { id: '', tenantId: '', cookie: '' };
const kenji = { id: '', cookie: '' };

function post(path: string, ip: string, body: object, cookie?: string) {
  return api.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      origin: appOrigin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

async function signedIn(email: string, ip: string): Promise<{ id: string; cookie: string }> {
  const res = await post('/api/auth/sign-in/email', ip, { email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((line) => line.startsWith('better-auth.session_token='));
  if (cookie === undefined) throw new Error('no session cookie in the sign-in response');
  return { id: (await res.json()).user.id, cookie: cookie.split(';')[0] };
}

function getMe(cookie?: string, path = '/api/v1/me') {
  return api.request(path, { headers: cookie === undefined ? {} : { cookie } });
}

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({
    error: 'Unauthorized',
    requestId: res.headers.get('x-request-id'),
  });
  expect(res.headers.get('cache-control')).toBe('private, no-store');
}

beforeAll(async () => {
  requireWritable();
  for (const email of ['amara.me@example.test', 'kenji.me@example.test']) {
    const body = { name: 'Fixture Person', email, password };
    expect((await post('/api/auth/sign-up/email', '203.0.113.10', body)).status).toBe(200);
  }
  Object.assign(amara, await signedIn('amara.me@example.test', '203.0.113.1'));
  Object.assign(kenji, await signedIn('kenji.me@example.test', '203.0.113.2'));
  amara.tenantId = await createTenant({ pool: app }, amara.id, 'amara-me');
});

afterAll(async () => {
  const query = rows(drizzle(auth));
  await query(sql`delete from users where email like '%.me@example.test'`);
  await query(
    sql`delete from rate_limits where key like '203.0.113.%' or key like '%.me@example.test|%'`,
  );
  await Promise.all([auth.end(), app.end()]);
});

describe('GET /api/v1/me', () => {
  it('answers a signed-in owner with their email and tenant, without a client IP header', async () => {
    const res = await getMe(amara.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: 'amara.me@example.test',
      tenant: { id: amara.tenantId, subdomain: 'amara-me' },
    });
  });

  it('answers a user without a tenant with tenant null, whatever ids the query names', async () => {
    const res = await getMe(
      kenji.cookie,
      `/api/v1/me?userId=${amara.id}&tenantId=${amara.tenantId}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'kenji.me@example.test', tenant: null });
  });

  it.each([
    ['no cookie', undefined],
    ['a forged session token', 'better-auth.session_token=forged-token-K5'],
    ['an empty session token', 'better-auth.session_token='],
    ['a cookie of another name', 'session=s1-K2'],
  ])('refuses %s with 401', async (_, cookie) => {
    await expectUnauthorized(await getMe(cookie));
  });

  it('refuses the cookie of a session that signed out', async () => {
    const { cookie } = await signedIn('kenji.me@example.test', '203.0.113.3');
    expect((await getMe(cookie)).status).toBe(200);
    const out = await post('/api/auth/sign-out', '203.0.113.3', {}, cookie);
    expect(out.status).toBe(200);
    await expectUnauthorized(await getMe(cookie));
  });
});
