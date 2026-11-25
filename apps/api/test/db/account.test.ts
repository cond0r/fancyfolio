import { isVersionToken, LIMITS } from '@fancyfolio/contracts';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect } from '../../../../packages/db/src/client.ts';
import { createTenant, requireWritable, rows } from '../../../../packages/db/test/fixtures.ts';
import type {} from '../../../../packages/db/test/setup.ts';

const { appUrl, authUrl } = inject('db');
const appOrigin = 'http://localhost:3200';
const password = 'correct-horse-battery-7';
const people = [
  'amara',
  'kenji',
  'ines',
  'lena',
  'omar',
  'rosa',
  'sami',
  'nadia',
  'tomas',
] as const;
type Person = (typeof people)[number];
const emailOf = (name: Person) => `${name}.account@example.test`;
vi.stubEnv('DATABASE_URL', appUrl);
vi.stubEnv('AUTH_DATABASE_URL', authUrl);
vi.stubEnv('SIGNUP_ALLOWLIST', people.map(emailOf).join(','));
const { default: api } = await import('../../src/index.ts');

const auth = connect(authUrl);
const app = connect(appUrl);
const session = {} as Record<Person, { id: string; cookie: string }>;
let amaraTenantId = '';

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

async function signedIn(name: Person, ip: string): Promise<{ id: string; cookie: string }> {
  const res = await post('/api/auth/sign-in/email', ip, { email: emailOf(name), password });
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

async function expectRefused(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error, requestId: res.headers.get('x-request-id') });
}

async function expectUnauthorized(res: Response) {
  await expectRefused(res, 401, 'Unauthorized');
  expect(res.headers.get('cache-control')).toBe('private, no-store');
}

type Sent = { origin?: string | null; type?: string };

function claim(body: unknown, cookie: string | undefined, options?: Sent) {
  return send('POST', '/api/v1/tenants', body, cookie, options);
}

function saveProfile(body: unknown, cookie: string | undefined, options?: Sent) {
  return send('PUT', '/api/v1/me/profile', body, cookie, options);
}

function send(
  method: string,
  path: string,
  body: unknown,
  cookie: string | undefined,
  { origin = appOrigin, type = 'application/json' }: Sent = {},
) {
  return api.request(path, {
    method,
    headers: {
      'content-type': type,
      ...(origin === null ? {} : { origin }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function tenantOf(cookie: string | undefined) {
  return (await (await getMe(cookie)).json()).tenant;
}

async function profileOf(name: Person) {
  const res = await getMe(session[name].cookie, '/api/v1/me/profile');
  expect(res.status).toBe(200);
  return res.json();
}

const form = 'application/x-www-form-urlencoded';
const evil = 'https://evil.example.test';
const refusals: Record<number, string> = {
  400: 'Bad request',
  403: 'Forbidden',
  413: 'Payload too large',
};

beforeAll(async () => {
  requireWritable();
  for (const [i, name] of people.entries()) {
    const ip = `203.0.113.${101 + i}`;
    const body = { name: 'Fixture Person', email: emailOf(name), password };
    expect((await post('/api/auth/sign-up/email', ip, body)).status).toBe(200);
    session[name] = await signedIn(name, ip);
  }
  amaraTenantId = await createTenant({ pool: app }, session.amara.id, 'amara-account');
  for (const name of ['nadia', 'tomas'] as const) {
    expect((await claim({ subdomain: `${name}-account` }, session[name].cookie)).status).toBe(201);
  }
});

afterAll(async () => {
  const query = rows(drizzle(auth));
  await query(sql`delete from users where email like '%.account@example.test'`);
  await query(
    sql`delete from rate_limits where key like '203.0.113.%' or key like '%.account@example.test|%' or key like '%|/v1/tenants'`,
  );
  await Promise.all([auth.end(), app.end()]);
});

describe('GET /api/v1/me', () => {
  it('answers a signed-in owner with their email and tenant, without a client IP header', async () => {
    const res = await getMe(session.amara.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: 'amara.account@example.test',
      tenant: { id: amaraTenantId, subdomain: 'amara-account' },
    });
  });

  it('answers a user without a tenant with tenant null, whatever ids the query names', async () => {
    const res = await getMe(
      session.kenji.cookie,
      `/api/v1/me?userId=${session.amara.id}&tenantId=${amaraTenantId}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'kenji.account@example.test', tenant: null });
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
    const { cookie } = await signedIn('kenji', '203.0.113.250');
    expect((await getMe(cookie)).status).toBe(200);
    const out = await post('/api/auth/sign-out', '203.0.113.250', {}, cookie);
    expect(out.status).toBe(200);
    await expectUnauthorized(await getMe(cookie));
  });
});

describe('POST /api/v1/tenants', () => {
  it('claims the subdomain with an empty profile once per user and once per name', async () => {
    const res = await claim({ subdomain: 'ines' }, session.ines.cookie);
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), subdomain: 'ines' });
    expect(await tenantOf(session.ines.cookie)).toEqual(created);
    const site = await api.request('/api/v1/sites/ines');
    expect(await site.json()).toMatchObject({
      tenantId: created.id,
      profile: {
        displayName: '',
        headline: '',
        location: '',
        bioMd: '',
        avatarUrl: null,
        links: [],
      },
    });

    const again = await claim({ subdomain: 'ines-two' }, session.ines.cookie);
    await expectRefused(again, 409, 'You already have a site');
    expect(await tenantOf(session.ines.cookie)).toEqual(created);
    await expectRefused(
      await claim({ subdomain: 'ines' }, session.kenji.cookie),
      409,
      'This subdomain is taken',
    );
    expect(await tenantOf(session.kenji.cookie)).toBeNull();
  });

  it('lets exactly one of two concurrent claims through, by one user or for one name', async () => {
    const sameUser = await Promise.all([
      claim({ subdomain: 'lena-a' }, session.lena.cookie),
      claim({ subdomain: 'lena-b' }, session.lena.cookie),
    ]);
    const sameName = await Promise.all([
      claim({ subdomain: 'contested' }, session.omar.cookie),
      claim({ subdomain: 'contested' }, session.rosa.cookie),
    ]);
    expect(sameUser.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(sameName.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(await tenantOf(session.lena.cookie)).toMatchObject({
      subdomain: expect.stringMatching(/^lena-[ab]$/),
    });
    const owners = [await tenantOf(session.omar.cookie), await tenantOf(session.rosa.cookie)];
    expect(owners.filter((tenant) => tenant !== null)).toHaveLength(1);
  });

  it('refuses the eleventh claim by one user within a minute with 429, not other users', async () => {
    const claims = await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        claim({ subdomain: `amara-${i}` }, session.amara.cookie),
      ),
    );
    expect(claims.map((res) => res.status).sort()).toEqual([...Array(10).fill(409), 429]);
    const limited = claims.find((res) => res.status === 429);
    if (limited === undefined) throw new Error('no claim was limited');
    await expectRefused(limited, 429, 'Too many requests');
    await expectRefused(
      await claim({ subdomain: 'amara-11' }, session.ines.cookie),
      409,
      'You already have a site',
    );
  });

  it.each([
    ['no cookie', undefined],
    ['a forged session token', 'better-auth.session_token=forged-token-K5'],
  ])('refuses %s with 401 before reading the body', async (_, cookie) => {
    await expectRefused(await claim({ subdomain: 'nobody-here' }, cookie), 401, 'Unauthorized');
    await expectRefused(await claim({ subdomain: 'admin', id: 'x' }, cookie), 401, 'Unauthorized');
  });

  const uuid = '00000000-0000-4000-8000-000000000001';
  it.each([
    ['a reserved name', { subdomain: 'admin' }],
    ['an IDNA label', { subdomain: 'xn--80ak6aa92e' }],
    ['upper case', { subdomain: 'Sami' }],
    ['two characters', { subdomain: 'sa' }],
    ['33 characters', { subdomain: 's'.repeat(33) }],
    ['a leading hyphen', { subdomain: '-sami' }],
    ['a trailing hyphen', { subdomain: 'sami-' }],
    ['a dot', { subdomain: 'sami.example' }],
    ['a space', { subdomain: 'sa mi' }],
    ['SQL', { subdomain: "sami'); drop table tenants; --" }],
    ['markup', { subdomain: '<script>alert(1)</script>' }],
    ['a path', { subdomain: '../sami' }],
    ['a number', { subdomain: 42 }],
    ['null', { subdomain: null }],
    ['no subdomain', {}],
    ['an id', { subdomain: 'sami', id: uuid }],
    ['an owner_id', { subdomain: 'sami', owner_id: uuid }],
    ['a tenant_id', { subdomain: 'sami', tenant_id: uuid }],
    ['an ownerId', { subdomain: 'sami', ownerId: uuid }],
    ['a prototype key', '{"subdomain":"sami","__proto__":{"admin":true}}'],
    ['an array', [{ subdomain: 'sami' }]],
    ['malformed JSON', '{"subdomain":'],
  ])('refuses %s with 400, echoes nothing and creates nothing', async (_, body) => {
    await expectRefused(await claim(body, session.sami.cookie), 400, 'Bad request');
    expect(await tenantOf(session.sami.cookie)).toBeNull();
  });

  const oversized = JSON.stringify({ subdomain: 'sami', pad: 'p'.repeat(8 * 1024) });
  const multipart = '--x\r\nContent-Disposition: form-data; name="subdomain"\r\n\r\nsami\r\n--x--';
  it.each([
    ['a JSON body sent as text/plain', 'text/plain', appOrigin, '{"subdomain":"sami"}', 400],
    ['a cross-site form post', form, evil, 'subdomain=sami', 403],
    ['a cross-site text/plain post', 'text/plain', evil, '{"subdomain":"sami"}', 403],
    ['a tenant-host form post', form, 'http://ines.localhost:3200', 'subdomain=sami', 403],
    ['a form post without an Origin', 'multipart/form-data; boundary=x', null, multipart, 403],
    ['a body over 8 KiB', 'application/json', appOrigin, oversized, 413],
  ])('refuses %s with the session cookie', async (_, type, origin, body, status) => {
    const res = await claim(body, session.sami.cookie, { origin, type });
    await expectRefused(res, status, refusals[status]);
    expect(await tenantOf(session.sami.cookie)).toBeNull();
  });
});

describe('/api/v1/me/profile', () => {
  const site = { label: 'Site', url: 'https://nadia.example/' };
  const saved = {
    displayName: "Nadia'); drop table profiles; --",
    headline: '<script>alert(1)</script>',
    location: '{{7*7}} Lisbon',
    bioMd: `<img src=x onerror=alert(1)>\n\n${':::'.repeat(LIMITS.markdownFences)}`,
    links: [
      ...Array.from({ length: LIMITS.links - 1 }, (_, i) => ({
        label: `<b>${i}</b>`,
        url: `https://nadia.example/?q=${i}'--`,
      })),
      { label: 'Mail', url: 'mailto:nadia@example.test' },
    ],
  };
  const stale = 'Changed elsewhere; reload and try again';
  const unusedToken = '2026-10-13 10:00:00.123456+00';

  it('saves every field verbatim with the token it read and refuses a stale second tab', async () => {
    const loaded = await profileOf('nadia');
    expect(loaded).toEqual({
      displayName: '',
      headline: '',
      location: '',
      bioMd: '',
      avatarUrl: null,
      links: [],
      updatedAt: expect.any(String),
    });
    expect(isVersionToken(loaded.updatedAt)).toBe(true);
    const first = await saveProfile(
      { ...saved, updatedAt: loaded.updatedAt },
      session.nadia.cookie,
    );
    expect(first.status).toBe(200);
    const answered = await first.json();
    expect(answered).toEqual({ ...saved, avatarUrl: null, updatedAt: expect.any(String) });
    expect(answered.updatedAt).not.toBe(loaded.updatedAt);
    const secondTab = { ...saved, headline: 'Tab two', updatedAt: loaded.updatedAt };
    await expectRefused(await saveProfile(secondTab, session.nadia.cookie), 409, stale);
    expect(await profileOf('nadia')).toEqual(answered);
    const again = { ...saved, headline: 'Principal engineer', updatedAt: answered.updatedAt };
    const next = await saveProfile(again, session.nadia.cookie);
    expect(next.status).toBe(200);
    expect(await profileOf('nadia')).toEqual(await next.json());
  });

  it('compares the token as an instant at microsecond precision', async () => {
    const { updatedAt } = await profileOf('nadia');
    const [near] = await rows<{ later: string; earlier: string; shifted: string }>(drizzle(app))(
      sql`select (${updatedAt}::timestamptz + interval '1 microsecond')::text as later, (${updatedAt}::timestamptz - interval '1 microsecond')::text as earlier, to_char(${updatedAt}::timestamptz at time zone interval '05:30', 'YYYY-MM-DD HH24:MI:SS.US') || '+05:30' as shifted`,
    );
    for (const token of [near.later, near.earlier]) {
      const body = { ...saved, displayName: 'Stale', updatedAt: token };
      await expectRefused(await saveProfile(body, session.nadia.cookie), 409, stale);
    }
    expect((await profileOf('nadia')).updatedAt).toBe(updatedAt);
    const shifted = await saveProfile({ ...saved, updatedAt: near.shifted }, session.nadia.cookie);
    expect(shifted.status).toBe(200);
  });

  it("changes only the caller's own profile", async () => {
    const before = await profileOf('nadia');
    const { updatedAt } = await profileOf('tomas');
    const body = { ...saved, displayName: 'Tomas Lind', updatedAt };
    expect((await saveProfile(body, session.tomas.cookie)).status).toBe(200);
    expect((await profileOf('tomas')).displayName).toBe('Tomas Lind');
    expect(await profileOf('nadia')).toEqual(before);
  });

  it.each([
    ['no cookie', () => undefined, { avatarUrl: 'x' }, 401, 'Unauthorized'],
    [
      'a forged session token',
      () => 'better-auth.session_token=forged-token-K6',
      { avatarUrl: 'x' },
      401,
      'Unauthorized',
    ],
    ['a user without a tenant', () => session.kenji.cookie, {}, 404, 'Not found'],
    ['an owner without a profile row', () => session.amara.cookie, {}, 404, 'Not found'],
  ])('refuses %s on read and save', async (_, cookie, patch, status, error) => {
    await expectRefused(await getMe(cookie(), '/api/v1/me/profile'), status, error);
    const body = { ...saved, updatedAt: unusedToken, ...patch };
    await expectRefused(await saveProfile(body, cookie()), status, error);
  });

  const uuid = '00000000-0000-4000-8000-000000000001';
  const over = (max: number) => 'a'.repeat(max + 1);
  it.each([
    ['an avatarUrl', { avatarUrl: 'https://nadia.example/a.webp' }],
    ['an avatar_url', { avatar_url: 'https://nadia.example/a.webp' }],
    ['a tenant_id', { tenant_id: uuid }],
    ['a tenantId', { tenantId: uuid }],
    ['an owner_id', { owner_id: uuid }],
    ['an id', { id: uuid }],
    ['an updated_at', { updated_at: unusedToken }],
    ['an unknown key', { theme: 'dark' }],
    ['no token', { updatedAt: undefined }],
    ['a token from a Date', { updatedAt: '2026-10-13T10:00:00.123Z' }],
    ['a missing field', { headline: undefined }],
    ['a number for text', { headline: 7 }],
    ['an over-long display name', { displayName: over(LIMITS.displayName) }],
    ['a NUL in the display name', { displayName: 'Nadia\u0000Example' }],
    ['a lone surrogate in a link label', { links: [{ ...site, label: 'a\ud800b' }] }],
    ['an over-long headline', { headline: over(LIMITS.headline) }],
    ['an over-long location', { location: over(LIMITS.location) }],
    ['an over-long bio', { bioMd: over(LIMITS.bioMd) }],
    ['a bio with 11 ::: fences', { bioMd: ':::'.repeat(LIMITS.markdownFences + 1) }],
    ['a javascript: link', { links: [{ ...site, url: 'javascript:alert(1)' }] }],
    ['a link with credentials', { links: [{ ...site, url: 'https://a:b@nadia.example/' }] }],
    ['an empty link label', { links: [{ ...site, label: '' }] }],
    ['an over-long link label', { links: [{ ...site, label: over(LIMITS.linkLabel) }] }],
    ['a link with an extra key', { links: [{ ...site, rel: 'me' }] }],
    ['eleven links', { links: Array(LIMITS.links + 1).fill(site) }],
  ])('refuses a body with %s with 400 and changes nothing', async (_, patch) => {
    const before = await profileOf('nadia');
    const body = { ...saved, updatedAt: before.updatedAt, ...patch };
    await expectRefused(await saveProfile(body, session.nadia.cookie), 400, 'Bad request');
    expect(await profileOf('nadia')).toEqual(before);
  });

  const json = 'application/json';
  const valid = JSON.stringify({ ...saved, updatedAt: unusedToken });
  const oversized = JSON.stringify({ ...saved, pad: 'p'.repeat(LIMITS.jsonBodyBytes) });
  it.each([
    ['a prototype key', json, appOrigin, valid.replace(/}$/, ',"__proto__":{"admin":true}}'), 400],
    ['an array', json, appOrigin, `[${valid}]`, 400],
    ['malformed JSON', json, appOrigin, '{"displayName":', 400],
    ['a JSON body sent as text/plain', 'text/plain', appOrigin, valid, 400],
    ['a cross-site form post', form, evil, 'displayName=Mallory', 403],
    ['a body over 1 MiB', json, appOrigin, oversized, 413],
  ])(
    'refuses %s with the session cookie and changes nothing',
    async (_, type, origin, body, status) => {
      const before = await profileOf('nadia');
      const res = await saveProfile(body, session.nadia.cookie, { origin, type });
      await expectRefused(res, status, refusals[status]);
      expect(await profileOf('nadia')).toEqual(before);
    },
  );
});
