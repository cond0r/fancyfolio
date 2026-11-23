import { LIMITS } from '@fancyfolio/contracts';
import { sql } from 'drizzle-orm';
import { drizzle, NodePgSession } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect } from '../../../../packages/db/src/client.ts';
import { requireWritable, rows } from '../../../../packages/db/test/fixtures.ts';
import type {} from '../../../../packages/db/test/setup.ts';

const { appUrl, authUrl } = inject('db');
const appOrigin = 'http://localhost:3200';
const password = 'correct-horse-battery-7';
const emails = [
  'ada.auth@example.test',
  'bo.auth@example.test',
  'cy.auth@example.test',
  'di.auth@example.test',
  'ed.auth@example.test',
  'fay.auth@example.test',
  'gus.auth@example.test',
  'hal.auth@example.test',
  'ida.auth@example.test',
];
vi.stubEnv('DATABASE_URL', appUrl);
vi.stubEnv('AUTH_DATABASE_URL', authUrl);
const { default: api } = await import('../../src/index.ts');
vi.resetModules();
vi.stubEnv('BETTER_AUTH_URL', 'https://fancyfolio.test');
const { default: httpsApi } = await import('../../src/index.ts');
vi.resetModules();
vi.stubEnv('BETTER_AUTH_URL', appOrigin);
vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
const { default: realIpApi } = await import('../../src/index.ts');
const { auth: realIpAuth } = await import('../../src/auth.ts');

const pool = connect(authUrl);
const query = rows(drizzle(pool));

type Call = { ip?: string; cookie?: string; origin?: string; headers?: Record<string, string> };

function call(
  app: typeof api,
  path: string,
  init: Call & { method?: string; body?: unknown } = {},
) {
  const headers = new Headers(init.headers);
  if (init.ip !== undefined) headers.set('x-forwarded-for', init.ip);
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  if (init.origin !== undefined) headers.set('origin', init.origin);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return app.request(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function signUp(email: string, ip: string) {
  return call(api, '/api/auth/sign-up/email', {
    ip,
    body: { name: 'Fixture Person', email, password },
  });
}

function signIn(
  email: string,
  ip: string,
  extra: Call & { secret?: string; callbackURL?: string } = {},
) {
  const { secret = password, callbackURL, ...rest } = extra;
  return call(api, '/api/auth/sign-in/email', {
    ip,
    ...rest,
    body: { email, password: secret, ...(callbackURL === undefined ? {} : { callbackURL }) },
  });
}

function sessionCookie(res: Response, name = 'better-auth.session_token'): string {
  const cookie = res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
  if (cookie === undefined) throw new Error(`no ${name} cookie in the response`);
  return cookie;
}

async function sessionUser(cookie: string, ip: string): Promise<string | null> {
  const res = await call(api, '/api/auth/get-session', { ip, cookie: cookie.split(';')[0] });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body === null ? null : body.user.email;
}

function rateLimitRows() {
  return query(sql`select key, count from rate_limits order by key`);
}

async function usersWith(email: string): Promise<number> {
  const [{ users }] = await query(
    sql`select count(*)::int as users from users where email = ${email}`,
  );
  return Number(users);
}

beforeAll(async () => {
  requireWritable();
  for (const [i, email] of emails.slice(5).entries()) {
    expect((await signUp(email, `198.51.100.${60 + i}`)).status).toBe(200);
  }
});

afterAll(async () => {
  await query(sql`delete from users where email like '%.auth@example.test'`);
  await query(sql`delete from rate_limits where key like '198.51.100.%'`);
  await pool.end();
});

describe('Better Auth rate limits, kept in the database per client IP', () => {
  it('refuses the sixth sign-up from one IP within an hour while another IP still signs up', async () => {
    for (const email of emails.slice(0, 5)) {
      expect((await signUp(email, '198.51.100.10')).status).toBe(200);
    }
    const refused = await signUp('zed.auth@example.test', '198.51.100.10');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('x-retry-after'))).toBeGreaterThan(3500);
    expect((await signUp('zed.auth@example.test', '198.51.100.11')).status).toBe(200);
    expect(await rateLimitRows()).toEqual(
      expect.arrayContaining([
        { key: '198.51.100.10|/sign-up/email', count: 5 },
        { key: '198.51.100.11|/sign-up/email', count: 1 },
      ]),
    );
  });

  it('refuses the eleventh sign-in from one IP within a minute while another IP still signs in', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await signIn('fay.auth@example.test', '198.51.100.20', {
        secret: 'wrong-password-1',
      });
      expect(res.status).toBe(401);
    }
    expect((await signIn('fay.auth@example.test', '198.51.100.20')).status).toBe(429);
    expect((await signIn('fay.auth@example.test', '198.51.100.21')).status).toBe(200);
    expect(await rateLimitRows()).toEqual(
      expect.arrayContaining([{ key: '198.51.100.20|/sign-in/email', count: 10 }]),
    );
  });

  it.each([
    ['without the header', undefined],
    ['with two IPs', '198.51.100.30, 198.51.100.31'],
  ])('answers 503 %s and writes no rate-limit row, shared or not', async (_, ip) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await rateLimitRows();
    for (const path of ['/api/auth/sign-in/email', '/api/auth/sign-up/email']) {
      const res = await call(api, path, {
        ip,
        body: { name: 'Fixture Person', email: 'gus.auth@example.test', password },
      });
      expect(res.status).toBe(503);
    }
    expect(await rateLimitRows()).toEqual(before);
    expect(before.filter(({ key }) => /^(no-trusted-ip|127\.0\.0\.1)\|/.test(String(key)))).toEqual(
      [],
    );
    vi.restoreAllMocks();
  });

  it('writes no rate-limit row for a served path without a limit or a path Better Auth does not serve to clients, which answers 404', async () => {
    const signedIn = await signIn('hal.auth@example.test', '198.51.100.91');
    expect(signedIn.status).toBe(200);
    const cookie = sessionCookie(signedIn).split(';')[0];
    const before = await rateLimitRows();
    for (const ip of ['198.51.100.92', '198.51.100.93', '2001:db8:40::1'])
      expect((await call(api, '/api/auth/ok', { ip })).status).toBe(200);
    for (const path of [
      '/api/auth/probe-path-1',
      '/api/auth/sign-in/email/2',
      '/api/auth/verify-password',
    ]) {
      const res = await call(api, path, {
        ip: '198.51.100.90',
        cookie,
        origin: appOrigin,
        body: { password },
      });
      expect(res.status).toBe(404);
    }
    expect(await rateLimitRows()).toEqual(before);
    const ip = '198.51.100.94';
    const body = { currentPassword: password, newPassword: password };
    expect((await call(api, '/api/auth/change-password', { ip, body })).status).toBe(401);
    expect(await rateLimitRows()).toContainEqual({ key: `${ip}|/change-password`, count: 1 });
  });

  it('fits the largest accepted sign-up and answers 413 to a longer body before the IP guard or the limiter', async () => {
    const largest = await call(api, '/api/auth/sign-up/email', {
      ip: '198.51.100.100',
      body: {
        name: '\u0001'.repeat(LIMITS.displayName),
        email: 'max.auth@example.test',
        password: '\u0001'.repeat(128),
        image: `https://${'\\'.repeat(LIMITS.url - 8)}`,
        callbackURL: `${appOrigin}/${'c'.repeat(LIMITS.url - appOrigin.length - 1)}`,
      },
    });
    expect(largest.status).toBe(200);
    const before = await rateLimitRows();
    const body = { email: 'jo.auth@example.test', password: 'p'.repeat(8 * 1024) };
    for (const ip of [undefined, '198.51.100.101'])
      expect((await call(api, '/api/auth/sign-in/email', { ip, body })).status).toBe(413);
    expect(await rateLimitRows()).toEqual(before);
  });

  it('reads only the configured client IP header, in the guard and the limiter', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = { email: 'ida.auth@example.test', password };
    const res = await call(realIpApi, '/api/auth/sign-in/email', {
      headers: { 'x-real-ip': '198.51.100.80' },
      body,
    });
    expect(res.status).toBe(200);
    expect(await rateLimitRows()).toEqual(
      expect.arrayContaining([{ key: '198.51.100.80|/sign-in/email', count: 1 }]),
    );
    expect(
      (await call(realIpApi, '/api/auth/sign-in/email', { ip: '198.51.100.81', body })).status,
    ).toBe(503);
    vi.restoreAllMocks();
  });
});

describe('sign-up', () => {
  it('creates no user when its credential account cannot be stored', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const internal = (await realIpAuth.$context).internalAdapter;
    vi.spyOn(internal, 'linkAccount').mockRejectedValueOnce(new Error('storage failed'));
    const res = await call(realIpApi, '/api/auth/sign-up/email', {
      headers: { 'x-real-ip': '198.51.100.82' },
      body: { name: 'Fixture Person', email: 'jo.auth@example.test', password },
    });
    expect(res.status).toBe(500);
    expect(await usersWith('jo.auth@example.test')).toBe(0);
    vi.restoreAllMocks();
  });
});

describe('sessions', () => {
  it('sets an HttpOnly, SameSite=Lax, host-only cookie, the only carrier of its token, that sign-out invalidates, and reads users only through native joins', async () => {
    const sent = vi.spyOn(NodePgSession.prototype, 'prepareQuery');
    const res = await signIn('gus.auth@example.test', '198.51.100.40');
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(
      /^better-auth\.session_token=[^;]+; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/,
    );
    const token = cookie.slice(cookie.indexOf('=') + 1).split('.')[0];
    const bodies = [await res.text()];
    for (const path of ['/api/auth/get-session', '/api/auth/list-sessions']) {
      const read = await call(api, path, { ip: '198.51.100.40', cookie: cookie.split(';')[0] });
      expect(read.status).toBe(200);
      bodies.push(await read.text());
    }
    for (const body of bodies) expect(body).not.toContain(token);
    expect(await sessionUser(cookie, '198.51.100.40')).toBe('gus.auth@example.test');
    expect(await query(sql`select ip_address from sessions where token = ${token}`)).toEqual([
      { ip_address: '198.51.100.40' },
    ]);
    const out = await call(api, '/api/auth/sign-out', {
      ip: '198.51.100.40',
      cookie: cookie.split(';')[0],
      origin: appOrigin,
      body: {},
    });
    expect(out.status).toBe(200);
    expect(await sessionUser(cookie, '198.51.100.40')).toBeNull();
    expect(await query(sql`select 1 from sessions where token = ${token}`)).toEqual([]);
    const reads = sent.mock.calls.map(([q]) => q.sql).filter((t) => t.includes(' from "users"'));
    expect(reads).not.toEqual([]);
    for (const text of reads) expect(text).toContain(' left join lateral ');
    vi.restoreAllMocks();
  });

  it('uses the __Secure- prefix and Secure when the app origin is https', async () => {
    const res = await call(httpsApi, 'https://fancyfolio.test/api/auth/sign-in/email', {
      ip: '198.51.100.41',
      body: { email: 'hal.auth@example.test', password },
    });
    expect(res.status).toBe(200);
    expect(sessionCookie(res, '__Secure-better-auth.session_token')).toMatch(
      /^__Secure-better-auth\.session_token=[^;]+; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
  });

  it('never adopts a session token the client brings (fixation)', async () => {
    const forged = 'better-auth.session_token=forged-token-K5';
    const res = await signIn('ida.auth@example.test', '198.51.100.42', {
      cookie: forged,
      origin: appOrigin,
    });
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).not.toContain('forged-token-K5');
    expect(await sessionUser(forged, '198.51.100.42')).toBeNull();
    expect(await sessionUser(cookie, '198.51.100.42')).toBe('ida.auth@example.test');
  });

  it('answers a wrong password and an unknown email alike', async () => {
    const wrong = await signIn('ida.auth@example.test', '198.51.100.43', {
      secret: 'wrong-password-1',
    });
    const unknown = await signIn('nobody.auth@example.test', '198.51.100.43');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });
});

describe('origin checks, forced on although the test environment would skip them', () => {
  it.each([
    [
      'sign-up',
      '/api/auth/sign-up/email',
      { name: 'Fixture Person', email: 'zoe.auth@example.test', password },
    ],
    ['sign-in', '/api/auth/sign-in/email', { email: 'ida.auth@example.test', password }],
  ])('refuses a cross-origin %s', async (_, path, body) => {
    const res = await call(api, path, {
      ip: '198.51.100.50',
      origin: 'https://evil.example.test',
      body,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'INVALID_ORIGIN' });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await usersWith('zoe.auth@example.test')).toBe(0);
  });

  it('refuses a cross-site navigation sign-in (login CSRF)', async () => {
    const res = await call(api, '/api/auth/sign-in/email', {
      ip: '198.51.100.51',
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
      body: { email: 'ida.auth@example.test', password },
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('refuses a cross-origin sign-out and keeps the session', async () => {
    const cookie = sessionCookie(await signIn('ida.auth@example.test', '198.51.100.52'));
    const out = await call(api, '/api/auth/sign-out', {
      ip: '198.51.100.52',
      cookie: cookie.split(';')[0],
      origin: 'https://evil.example.test',
      body: {},
    });
    expect(out.status).toBe(403);
    expect(await sessionUser(cookie, '198.51.100.52')).toBe('ida.auth@example.test');
  });

  it.each([
    'https://evil.example.test/welcome',
    '//evil.example.test',
    '/\\evil.example.test',
    'http://localhost:3200.evil.example.test/',
    'javascript:alert(1)',
  ])('refuses the callback URL %s', async (callbackURL) => {
    const res = await signIn('ida.auth@example.test', '198.51.100.53', { callbackURL });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'INVALID_CALLBACK_URL' });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('accepts a callback path on the app origin', async () => {
    const res = await signIn('ida.auth@example.test', '198.51.100.54', {
      callbackURL: '/dashboard',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ redirect: true, url: '/dashboard' });
  });
});

describe('the auth routes inherit the API shell', () => {
  it("serves Better Auth's HTML error page with no-store, nosniff and default-src 'none'", async () => {
    const res = await call(api, '/api/auth/error?error=unknown', { ip: '198.51.100.70' });
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
