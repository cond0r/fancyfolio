import { format } from 'node:util';
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
  'jay.auth@example.test',
];
vi.stubEnv('DATABASE_URL', appUrl);
vi.stubEnv('AUTH_DATABASE_URL', authUrl);
vi.stubEnv('SIGNUP_ALLOWLIST', [...emails, 'zed.auth@example.test', 'jo.auth@example.test'].join());
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
const { adapter, internalAdapter, logger, password: hasher } = await realIpAuth.$context;

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
  await query(sql`
    delete from rate_limits
    where key like '198.51.100.%' or key like '2001:0db8:%' or key like '%.auth@example.test|%'
      or key like '%|/change-password'
  `);
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

  it('refuses the eleventh sign-in within a minute from one IPv6 /48 or for one email', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const byIp = await signIn(`probe${attempt}.auth@example.test`, `2001:db8:20:${attempt}::1`);
      expect(byIp.status).toBe(401);
      const byEmail = await signIn('jay.auth@example.test', `198.51.100.${100 + attempt}`, {
        secret: 'wrong-password-1',
      });
      expect(byEmail.status).toBe(401);
    }
    expect((await signIn('fay.auth@example.test', '2001:db8:20:ff::1')).status).toBe(429);
    expect((await signIn('fay.auth@example.test', '2001:db8:21::1')).status).toBe(200);
    expect((await signIn('JAY.auth@example.test', '198.51.100.110')).status).toBe(429);
    expect(await rateLimitRows()).toEqual(
      expect.arrayContaining([
        { key: '2001:0db8:0020:0000:0000:0000:0000:0000|/sign-in/email', count: 10 },
        { key: 'jay.auth@example.test|/sign-in/email', count: 10 },
      ]),
    );
  });

  it("lets only that email's signed device cookie past a full per-email limit", async () => {
    const device = 'better-auth.trusted_device';
    const cookieOf = async (email: string, ip: string) => {
      const res = await signIn(email, ip);
      expect(res.status).toBe(200);
      return sessionCookie(res, device).split(';')[0];
    };
    const owner = await cookieOf('ed.auth@example.test', '198.51.100.120');
    const other = await cookieOf('di.auth@example.test', '198.51.100.121');
    for (let attempt = 0; attempt < 9; attempt++) {
      const res = await signIn('ed.auth@example.test', `198.51.100.${130 + attempt}`, {
        secret: 'wrong-password-1',
      });
      expect(res.status).toBe(401);
    }
    for (const [ip, cookie] of [
      ['198.51.100.140', undefined],
      ['198.51.100.141', other],
      ['198.51.100.142', other.replace('di.auth', 'ed.auth')],
    ] as const) {
      expect((await signIn('ed.auth@example.test', ip, { cookie, origin: appOrigin })).status).toBe(
        429,
      );
    }
    const trusted = await signIn('ed.auth@example.test', '198.51.100.143', {
      cookie: owner,
      origin: appOrigin,
    });
    expect(trusted.status).toBe(200);
    expect(sessionCookie(trusted, device)).toMatch(/; Max-Age=2592000; /);
  });

  it('refuses the eleventh change-password within a minute for one user from any IP, and one whose session read fails, before the password check', async () => {
    const cookie = sessionCookie(await signIn('hal.auth@example.test', '198.51.100.150'));
    const verify = vi.spyOn(hasher, 'verify');
    vi.spyOn(internalAdapter, 'findSession').mockRejectedValueOnce(new Error('read failed'));
    const unread = await call(realIpApi, '/api/auth/change-password', {
      headers: { 'x-real-ip': '198.51.100.149' },
      cookie: cookie.split(';')[0],
      origin: appOrigin,
      body: { currentPassword: password, newPassword: password },
    });
    expect(unread.status).toBe(401);
    expect(await unread.json()).toEqual({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
    expect(verify).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const change = (ip: string, currentPassword: string) =>
      call(api, '/api/auth/change-password', {
        ip,
        cookie: cookie.split(';')[0],
        origin: appOrigin,
        body: { currentPassword, newPassword: password },
      });
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await change(`198.51.100.${151 + attempt}`, 'wrong-password-1')).status).toBe(400);
    expect((await change('2001:db8:30::1', password)).status).toBe(429);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 86_400_000 });
    const refreshed = await change('2001:db8:31::1', password);
    vi.useRealTimers();
    expect(refreshed.status).toBe(200);
    expect(sessionCookie(refreshed)).toMatch(/; Max-Age=604800; /);
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
      '/api/auth/callback/probe-1',
      '/api/auth/reset-password/probe-1',
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

  it('writes no key for an over-long email and prunes rows past the longest window', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    const now = Date.now();
    await query(sql`
      insert into rate_limits (key, count, last_request) values
        ('198.51.100.94|/sign-up/email', 1, ${now - 3_601_000}),
        ('198.51.100.95|/sign-up/email', 1, ${now - 3_500_000})
    `);
    const overLong = `${'x'.repeat(240)}.auth@example.test`;
    const unknown = await signIn('kim.auth@example.test', '198.51.100.93');
    const long = await signIn(overLong, '198.51.100.93');
    expect(long.status).toBe(401);
    expect(await long.json()).toEqual(await unknown.json());
    await vi.waitFor(async () => {
      const left = (await rateLimitRows()).map(({ key }) => key);
      expect(left).not.toContain('198.51.100.94|/sign-up/email');
    });
    const keys = (await rateLimitRows()).map(({ key }) => key);
    expect(keys).toContain('kim.auth@example.test|/sign-in/email');
    expect(keys).not.toContain(`${overLong}|/sign-in/email`);
    expect(keys).toContain('198.51.100.95|/sign-up/email');
    vi.useRealTimers();
  });

  it('plans the prune delete on the last_request index', async () => {
    const rollback = new Error('rollback');
    const now = Date.now();
    let plan: Record<string, unknown>[] = [];
    await expect(
      drizzle(pool).transaction(async (tx) => {
        await tx.execute(sql`
          insert into rate_limits (key, count, last_request)
          select '198.51.100.97|' || n, 1, ${now}::bigint - n * 60000
          from generate_series(1, 200) as n
        `);
        await tx.execute(sql`set local enable_seqscan = off`);
        plan = await rows(tx)(
          sql`explain delete from rate_limits where last_request < ${now - 3_600_000}`,
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(plan.map((line) => line['QUERY PLAN']).join('\n')).toContain(
      'rate_limits_last_request_idx',
    );
  });

  it('answers a new email before its prune settles, hands the prune to waitUntil once per window and logs a failed prune as name and code', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    vi.stubGlobal(Symbol.for('@vercel/request-context'), { get: () => ({ waitUntil }) });
    const prune = Promise.withResolvers<never>();
    const pruned = vi.spyOn(adapter, 'deleteMany').mockReturnValueOnce(prune.promise);
    const signInNew = (email: string, ip = '198.51.100.96') =>
      call(realIpApi, '/api/auth/sign-in/email', {
        headers: { 'x-real-ip': ip },
        body: { email, password },
      });
    expect((await signInNew('lee.auth@example.test')).status).toBe(401);
    expect(pruned).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    prune.reject(Object.assign(new Error('prune of lee.auth@example.test'), { code: '57014' }));
    await waitUntil.mock.calls[0][0];
    const line = JSON.stringify({ auth: 'error', error: 'Error', code: '57014' });
    expect(printed).toHaveBeenCalledWith(line);
    const output = printed.mock.calls.map((args) => format(...args)).join('\n');
    expect(output).not.toContain('lee.auth');
    expect((await signInNew('mo.auth@example.test')).status).toBe(401);
    expect(pruned).toHaveBeenCalledOnce();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    expect((await signInNew('nia.auth@example.test', '198.51.100.98')).status).toBe(401);
    expect(pruned).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    vi.spyOn(internalAdapter, 'linkAccount').mockRejectedValueOnce(new Error('storage failed'));
    const res = await call(realIpApi, '/api/auth/sign-up/email', {
      headers: { 'x-real-ip': '198.51.100.82' },
      body: { name: 'Fixture Person', email: 'jo.auth@example.test', password },
    });
    expect(res.status).toBe(500);
    expect(await usersWith('jo.auth@example.test')).toBe(0);
    vi.restoreAllMocks();
  });
});

describe('a failed auth query', () => {
  let failed: unknown;
  function failing<T>(query: Promise<T>): Promise<T> {
    return query.catch((error: unknown) => {
      failed = error;
      throw error;
    });
  }

  it.each([
    [
      'an account insert, with its password hash',
      500,
      '23503',
      async () => {
        const { linkAccount } = internalAdapter;
        vi.spyOn(internalAdapter, 'linkAccount').mockImplementationOnce((account) =>
          failing(linkAccount({ ...account, userId: crypto.randomUUID() })),
        );
        return call(realIpApi, '/api/auth/sign-up/email', {
          headers: { 'x-real-ip': '198.51.100.83' },
          body: { name: 'Fixture Person', email: 'jo.auth@example.test', password },
        });
      },
    ],
    [
      'a session insert, with its token and client IP',
      500,
      '23503',
      async () => {
        const { createSession } = internalAdapter;
        vi.spyOn(internalAdapter, 'createSession').mockImplementationOnce((_, ...rest) =>
          failing(createSession(crypto.randomUUID(), ...rest)),
        );
        return call(realIpApi, '/api/auth/sign-in/email', {
          headers: { 'x-real-ip': '198.51.100.84' },
          body: { email: 'ida.auth@example.test', password },
        });
      },
    ],
    [
      'a session lookup on sign-out, with its token',
      200,
      '22021',
      async () => {
        const signedIn = await call(realIpApi, '/api/auth/sign-in/email', {
          headers: { 'x-real-ip': '198.51.100.85' },
          body: { email: 'ida.auth@example.test', password },
        });
        const { findSession } = internalAdapter;
        vi.spyOn(internalAdapter, 'findSession').mockImplementationOnce((token) =>
          failing(findSession(`${token}\0`)),
        );
        return call(realIpApi, '/api/auth/sign-out', {
          headers: { 'x-real-ip': '198.51.100.85' },
          cookie: sessionCookie(signedIn).split(';')[0],
          origin: appOrigin,
          body: {},
        });
      },
    ],
  ])('logs %s as its error name and code only', async (_, status, code, send) => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await send()).status).toBe(status);
    const output = printed.mock.calls.map((args) => format(...args)).join('\n');
    expect(output).toContain(`"code":"${code}"`);
    const params =
      failed instanceof Error && 'params' in failed && Array.isArray(failed.params)
        ? failed.params
        : [];
    const secrets = params
      .flatMap((param) => (typeof param === 'string' ? param.split('\0') : []))
      .filter(Boolean);
    expect(secrets).not.toEqual([]);
    for (const secret of secrets) expect(output).not.toContain(secret);
    vi.restoreAllMocks();
  });
});

describe.runIf(inject('db').mode === 'local')('an auth database role that bypasses RLS', () => {
  it('is refused at first use without printing its URL', async () => {
    const { ownerUrl } = inject('db');
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    vi.stubEnv('AUTH_DATABASE_URL', ownerUrl);
    const { default: ownerApi } = await import('../../src/index.ts');
    const res = await call(ownerApi, '/api/auth/sign-in/email', {
      headers: { 'x-real-ip': '198.51.100.90' },
      body: { email: 'fay.auth@example.test', password },
    });
    expect(res.status).toBe(500);
    const output = [await res.text(), ...printed.mock.calls.map((args) => format(...args))].join();
    for (const part of [ownerUrl, decodeURIComponent(new URL(ownerUrl).password)].filter(Boolean)) {
      expect(output).not.toContain(part);
    }
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
    const changed = await call(api, '/api/auth/change-password', {
      ip: '198.51.100.40',
      cookie: cookie.split(';')[0],
      origin: appOrigin,
      body: { currentPassword: password, newPassword: password, revokeOtherSessions: true },
    });
    expect(changed.status).toBe(200);
    const renewed = sessionCookie(changed);
    const renewedToken = renewed.slice(renewed.indexOf('=') + 1).split('.')[0];
    expect(await changed.text()).not.toContain(renewedToken);
    const out = await call(api, '/api/auth/sign-out', {
      ip: '198.51.100.40',
      cookie: renewed.split(';')[0],
      origin: appOrigin,
      body: {},
    });
    expect(out.status).toBe(200);
    expect(await sessionUser(renewed, '198.51.100.40')).toBeNull();
    expect(await query(sql`select 1 from sessions where token = ${renewedToken}`)).toEqual([]);
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
    expect(sessionCookie(res, '__Secure-better-auth.trusted_device')).toMatch(
      /^__Secure-better-auth\.trusted_device=hal\.auth%40example\.test\.[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
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
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrong = await signIn('ida.auth@example.test', '198.51.100.43', {
      secret: 'wrong-password-1',
    });
    const unknown = await signIn('nobody.auth@example.test', '198.51.100.43');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
    for (const message of ['Invalid password', 'User not found']) {
      expect(printed).toHaveBeenCalledWith(JSON.stringify({ auth: 'warn', message }));
    }
    vi.restoreAllMocks();
  });

  it('prints a known Better Auth warning without its args and any other message as its level only', () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.warn('Invalid password', 'ida.auth@example.test');
    logger.warn('Invalid origin: https://ida.auth.example.test');
    logger.error('Blocked cross-site navigation login attempt (CSRF protection)', {
      referer: 'https://evil.example.test',
    });
    expect(printed.mock.calls).toEqual([
      [JSON.stringify({ auth: 'warn', message: 'Invalid password' })],
      [JSON.stringify({ auth: 'warn' })],
      [
        JSON.stringify({
          auth: 'error',
          message: 'Blocked cross-site navigation login attempt (CSRF protection)',
        }),
      ],
    ]);
    vi.restoreAllMocks();
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
