import { randomUUID } from 'node:crypto';
import { LIMITS } from '@fancyfolio/contracts';
import { experiences } from '@fancyfolio/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { connect } from '../../../../packages/db/src/client.ts';
import { withTenant } from '../../../../packages/db/src/with-tenant.ts';
import { createTenant, requireWritable, rows } from '../../../../packages/db/test/fixtures.ts';
import type {} from '../../../../packages/db/test/setup.ts';

const { appUrl, authUrl } = inject('db');
const appOrigin = 'http://localhost:3200';
const password = 'correct-horse-battery-7';
const people = ['aiko', 'bruno', 'chidi', 'dana'] as const;
type Person = (typeof people)[number];
const emailOf = (name: Person) => `${name}.items@example.test`;
vi.stubEnv('DATABASE_URL', appUrl);
vi.stubEnv('AUTH_DATABASE_URL', authUrl);
vi.stubEnv('SIGNUP_ALLOWLIST', people.map(emailOf).join(','));
const { default: api } = await import('../../src/index.ts');

const auth = connect(authUrl);
const app = connect(appUrl);
const session = {} as Record<Person, { id: string; cookie: string }>;
const path = '/api/v1/me/experiences';
const item = (id: string) => `${path}/${id}`;
const stale = 'Changed elsewhere; reload and try again';
const job = {
  company: 'Northwind Labs',
  role: 'Staff engineer',
  location: 'Remote',
  startsOn: '2022-03-01',
  endsOn: null as string | null,
  summaryMd: 'Led the **billing** rewrite.',
};

type Sent = {
  body?: unknown;
  cookie?: string;
  type?: string;
  origin?: string | null;
  key?: string;
};

function send(
  method: string,
  to: string,
  { body, cookie, type = 'application/json', origin = appOrigin, key }: Sent = {},
) {
  return api.request(to, {
    method,
    headers: {
      'content-type': type,
      ...(origin === null ? {} : { origin }),
      ...(cookie === undefined ? {} : { cookie }),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function create(name: Person, body: unknown, key: string | null = randomUUID()) {
  return send('POST', path, { body, cookie: session[name].cookie, key: key ?? undefined });
}

function everyRoute(cookie: string | undefined, id: string, updatedAt: string, extra = {}) {
  return Promise.all([
    send('GET', path, { cookie }),
    send('POST', path, { cookie, body: { ...job, ...extra }, key: randomUUID() }),
    send('GET', item(id), { cookie }),
    send('PUT', item(id), { cookie, body: { ...job, updatedAt, ...extra } }),
    send('DELETE', item(id), { cookie, body: { updatedAt, ...extra } }),
  ]);
}

async function expectRefused(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error, requestId: res.headers.get('x-request-id') });
}

function asUser<T>(name: Person, fn: Parameters<typeof withTenant<T>>[2]) {
  return withTenant({ pool: app }, { kind: 'user', userId: session[name].id }, fn);
}

function rowsOf(name: Person) {
  return asUser(name, (tx) => tx.select().from(experiences).orderBy(experiences.id));
}

async function seed(name: Person): Promise<typeof job & { id: string; updatedAt: string }> {
  const res = await create(name, job);
  expect(res.status).toBe(201);
  return res.json();
}

beforeAll(async () => {
  requireWritable();
  for (const [i, name] of people.entries()) {
    const ip = `203.0.113.${131 + i}`;
    const body = { name: 'Fixture Person', email: emailOf(name), password };
    for (const step of ['sign-up', 'sign-in']) {
      const res = await api.request(`/api/auth/${step}/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, origin: appOrigin },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const cookie = res.headers
        .getSetCookie()
        .find((line) => line.startsWith('better-auth.session_token='));
      session[name] = { id: (await res.json()).user.id, cookie: cookie?.split(';')[0] ?? '' };
    }
    if (name !== 'chidi') await createTenant({ pool: app }, session[name].id, `${name}-items`);
  }
});

beforeEach(async () => {
  for (const name of ['aiko', 'bruno', 'dana'] as const) {
    await asUser(name, (tx) => tx.delete(experiences));
  }
});

afterAll(async () => {
  const query = rows(drizzle(auth));
  await query(sql`delete from users where email like '%.items@example.test'`);
  await query(
    sql`delete from rate_limits where key like '203.0.113.13_|%' or key like '%.items@example.test|%'`,
  );
  await Promise.all([auth.end(), app.end()]);
});

describe('/api/v1/me/experiences', () => {
  it('creates under the idempotency key, lists latest start first and reads it verbatim', async () => {
    const hostile = {
      ...job,
      company: "Acme'); drop table experiences; --",
      role: '<script>alert(1)</script>',
      location: '{{7*7}}',
      summaryMd: `<img src=x onerror=alert(1)>\n\n${':::'.repeat(LIMITS.markdownFences)}`,
    };
    const key = randomUUID();
    const res = await create('aiko', hostile, key);
    expect(res.status).toBe(201);
    const newer = await res.json();
    expect(newer).toEqual({ id: key, ...hostile, updatedAt: expect.any(String) });
    const older = await (await create('aiko', { ...job, startsOn: '2018-01-01' })).json();
    await seed('bruno');
    const { cookie } = session.aiko;
    const list = await send('GET', path, { cookie });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([newer, older]);
    expect(await (await send('GET', item(key), { cookie })).json()).toEqual(newer);
    expect((await rowsOf('aiko')).map((row) => row.company).sort()).toEqual(
      [hostile.company, job.company].sort(),
    );
  });

  it('answers a double submit and concurrent repeats of one key with the one row it created', async () => {
    const key = randomUUID();
    const first = await create('aiko', job, key);
    const second = await create('aiko', { ...job, role: 'Changed' }, key);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(await second.json()).toEqual(await first.json());
    const racing = randomUUID();
    const raced = await Promise.all([1, 2, 3].map(() => create('aiko', job, racing)));
    expect(raced.map((res) => res.status)).toEqual([201, 201, 201]);
    expect((await rowsOf('aiko')).map((row) => row.id)).toEqual([key, racing].sort());
  });

  it("refuses a key that is another tenant's experience id with 409 and changes nothing", async () => {
    const theirs = await seed('bruno');
    const before = await rowsOf('bruno');
    await expectRefused(await create('aiko', job, theirs.id), 409, 'Conflict');
    expect(await rowsOf('aiko')).toEqual([]);
    expect(await rowsOf('bruno')).toEqual(before);
  });

  it(`lets one of four concurrent creates take place ${LIMITS.experiences} and answers its key after`, async () => {
    await asUser('dana', (tx, tenantId) =>
      tx
        .insert(experiences)
        .values(Array(LIMITS.experiences - 1).fill({ ...job, tenantId: tenantId ?? '' })),
    );
    const keys = [1, 2, 3, 4].map(() => randomUUID());
    const results = await Promise.all(keys.map((key) => create('dana', job, key)));
    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409, 409]);
    const refused = results.find((res) => res.status === 409);
    if (refused === undefined) throw new Error('no refused create');
    await expectRefused(refused, 409, `You can keep at most ${LIMITS.experiences} experiences`);
    const winner = keys[results.findIndex((res) => res.status === 201)];
    expect((await create('dana', job, winner)).status).toBe(201);
    expect(await rowsOf('dana')).toHaveLength(LIMITS.experiences);
  });

  it('answers 503 and writes nothing when a create waits out the lock timeout', async () => {
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = asUser('aiko', async (tx, tenantId) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const res = await create('aiko', job);
    release.resolve();
    await holder;
    await expectRefused(res, 503, 'Service unavailable');
    expect(await rowsOf('aiko')).toEqual([]);
  });

  const over = (max: number) => 'a'.repeat(max + 1);
  it.each<[string, unknown, (string | null)?]>([
    ['no key', job, null],
    ['a key that is not a uuid', job, 'submit-1'],
    ['a SQL key', job, "1' or '1'='1"],
    ['an id', { ...job, id: randomUUID() }],
    ['a tenant_id', { ...job, tenant_id: randomUUID() }],
    ['a tenantId', { ...job, tenantId: randomUUID() }],
    ['an owner_id', { ...job, owner_id: randomUUID() }],
    ['an updatedAt', { ...job, updatedAt: '2026-10-13 10:00:00.123456+00' }],
    ['an unknown key', { ...job, featured: true }],
    ['a prototype key', `{"company":"x","__proto__":{"admin":true}}`],
    ['a missing field', { company: 'Northwind Labs' }],
    ['an array body', [job]],
    ['an empty company', { ...job, company: '' }],
    ['an over-long company', { ...job, company: over(LIMITS.company) }],
    ['an empty role', { ...job, role: '' }],
    ['an over-long role', { ...job, role: over(LIMITS.role) }],
    ['an over-long location', { ...job, location: over(LIMITS.location) }],
    ['an over-long summary', { ...job, summaryMd: over(LIMITS.summaryMd) }],
    ['a summary with 11 ::: fences', { ...job, summaryMd: ':::'.repeat(11) }],
    ['February 30', { ...job, startsOn: '2026-02-30' }],
    ['month 13', { ...job, startsOn: '2026-13-01' }],
    ['a timestamp for a date', { ...job, startsOn: '2022-03-01T00:00:00Z' }],
    ['a number for a date', { ...job, startsOn: 20220301 }],
    ['an end before the start', { ...job, endsOn: '2022-02-28' }],
  ])('refuses a create with %s with 400 and creates nothing', async (_, body, key) => {
    await expectRefused(await create('aiko', body, key), 400, 'Bad request');
    expect(await rowsOf('aiko')).toEqual([]);
  });

  it('saves with the loaded token and refuses a second tab or a token one microsecond off', async () => {
    const loaded = await seed('aiko');
    const { cookie } = session.aiko;
    const res = await send('PUT', item(loaded.id), {
      cookie,
      body: { ...job, role: 'Principal', updatedAt: loaded.updatedAt },
    });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved).toEqual({ ...loaded, role: 'Principal', updatedAt: expect.any(String) });
    expect(saved.updatedAt).not.toBe(loaded.updatedAt);
    const [{ later }] = await rows<{ later: string }>(drizzle(app))(
      sql`select (${saved.updatedAt}::timestamptz + interval '1 microsecond')::text as later`,
    );
    const kept = await rowsOf('aiko');
    for (const updatedAt of [loaded.updatedAt, later]) {
      const body = { ...job, role: 'Tab two', updatedAt };
      await expectRefused(await send('PUT', item(loaded.id), { cookie, body }), 409, stale);
      const removed = await send('DELETE', item(loaded.id), { cookie, body: { updatedAt } });
      await expectRefused(removed, 409, stale);
    }
    expect(await rowsOf('aiko')).toEqual(kept);
  });

  it('deletes with the loaded token, then answers 404 and creates the key again with a new token', async () => {
    const first = await seed('aiko');
    const { cookie } = session.aiko;
    const token = { updatedAt: first.updatedAt };
    const res = await send('DELETE', item(first.id), { cookie, body: token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: first.id });
    expect(await rowsOf('aiko')).toEqual([]);
    const body = { ...job, ...token };
    await expectRefused(await send('PUT', item(first.id), { cookie, body }), 404, 'Not found');
    await expectRefused(
      await send('DELETE', item(first.id), { cookie, body: token }),
      404,
      'Not found',
    );
    const again = await create('aiko', job, first.id);
    expect(again.status).toBe(201);
    expect((await again.json()).updatedAt).not.toBe(first.updatedAt);
    await expectRefused(await send('PUT', item(first.id), { cookie, body }), 409, stale);
  });

  it.each([
    ['PUT', 'no token', () => job],
    ['PUT', 'a malformed token', () => ({ ...job, updatedAt: '2026-10-13T10:00:00.123Z' })],
    ['PUT', 'an id', (updatedAt: string) => ({ ...job, updatedAt, id: randomUUID() })],
    ['PUT', 'a tenant_id', (updatedAt: string) => ({ ...job, updatedAt, tenant_id: randomUUID() })],
    [
      'PUT',
      'an end before the start',
      (updatedAt: string) => ({ ...job, updatedAt, endsOn: '2022-02-28' }),
    ],
    ['DELETE', 'no body', () => undefined],
    ['DELETE', 'no token', () => ({})],
    ['DELETE', 'an extra key', (updatedAt: string) => ({ updatedAt, id: randomUUID() })],
  ])('refuses a %s with %s with 400 and changes nothing', async (method, _, bodyOf) => {
    const loaded = await seed('aiko');
    const before = await rowsOf('aiko');
    const body = bodyOf(loaded.updatedAt);
    const res = await send(method, item(loaded.id), { cookie: session.aiko.cookie, body });
    await expectRefused(res, 400, 'Bad request');
    expect(await rowsOf('aiko')).toEqual(before);
  });

  it("answers 404 for another tenant's, unknown, malformed and SQL ids and changes nothing", async () => {
    const theirs = await seed('bruno');
    const before = await rowsOf('bruno');
    const { cookie } = session.aiko;
    for (const id of [theirs.id, randomUUID(), 'not-a-uuid', "1'%20or%20'1'='1"]) {
      const answered = await everyRoute(cookie, id, theirs.updatedAt);
      expect(
        answered.slice(2).map((res) => res.status),
        id,
      ).toEqual([404, 404, 404]);
    }
    expect(await rowsOf('bruno')).toEqual(before);
  });
});

describe('actors other than the owner', () => {
  it.each([
    ['no cookie, even with invalid bodies', () => undefined, { tenant_id: '' }, 401],
    [
      'a forged session token, even with invalid bodies',
      () => 'better-auth.session_token=forged-token-E1',
      { tenant_id: '' },
      401,
    ],
    ['a signed-in user without a tenant', () => session.chidi.cookie, {}, 404],
  ])('refuses %s on every route and changes nothing', async (_, cookie, extra, status) => {
    const loaded = await seed('aiko');
    const before = await rowsOf('aiko');
    const error = status === 401 ? 'Unauthorized' : 'Not found';
    for (const res of await everyRoute(cookie(), loaded.id, loaded.updatedAt, extra)) {
      await expectRefused(res, status, error);
    }
    expect(await rowsOf('aiko')).toEqual(before);
  });

  const form = 'application/x-www-form-urlencoded';
  const evil = 'https://evil.example.test';
  it.each([
    ['a cross-site form post', 'POST', form, evil],
    ['a cross-site text/plain post', 'POST', 'text/plain', evil],
    ['a tenant-host form post', 'POST', form, 'http://aiko-items.localhost:3200'],
    ['a form post without an Origin', 'POST', 'multipart/form-data; boundary=x', null],
    ['a cross-site form save', 'PUT', form, evil],
    ['a cross-site form delete', 'DELETE', form, evil],
  ])(
    'refuses %s with the owner cookie with 403 and changes nothing',
    async (_, method, type, origin) => {
      const loaded = await seed('aiko');
      const before = await rowsOf('aiko');
      const res = await send(method, method === 'POST' ? path : item(loaded.id), {
        body: `company=Mallory&updatedAt=${encodeURIComponent(loaded.updatedAt)}`,
        cookie: session.aiko.cookie,
        type,
        origin,
        key: randomUUID(),
      });
      await expectRefused(res, 403, 'Forbidden');
      expect(await rowsOf('aiko')).toEqual(before);
    },
  );
});
