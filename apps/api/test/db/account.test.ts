import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect } from '../../../../packages/db/src/client.ts';
import { createTenant, requireWritable, rows } from '../../../../packages/db/test/fixtures.ts';
import type {} from '../../../../packages/db/test/setup.ts';

const { appUrl, authUrl } = inject('db');
const appOrigin = 'http://localhost:3200';
const password = 'correct-horse-battery-7';
const people = ['amara', 'kenji', 'ines', 'lena', 'omar', 'rosa', 'sami'] as const;
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

function claim(
  body: unknown,
  cookie: string | undefined,
  { origin = appOrigin, type = 'application/json' }: { origin?: string | null; type?: string } = {},
) {
  return api.request('/api/v1/tenants', {
    method: 'POST',
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

beforeAll(async () => {
  requireWritable();
  for (const [i, name] of people.entries()) {
    const ip = `203.0.113.${101 + i}`;
    const body = { name: 'Fixture Person', email: emailOf(name), password };
    expect((await post('/api/auth/sign-up/email', ip, body)).status).toBe(200);
    session[name] = await signedIn(name, ip);
  }
  amaraTenantId = await createTenant({ pool: app }, session.amara.id, 'amara-account');
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

  const form = 'application/x-www-form-urlencoded';
  const evil = 'https://evil.example.test';
  const oversized = JSON.stringify({ subdomain: 'sami', pad: 'p'.repeat(8 * 1024) });
  const refusals: Record<number, string> = {
    400: 'Bad request',
    403: 'Forbidden',
    413: 'Payload too large',
  };
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
