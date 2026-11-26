import { randomUUID } from 'node:crypto';
import { LIMITS } from '@fancyfolio/contracts';
import { experiences, projects, type TenantTransaction } from '@fancyfolio/db';
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
const stale = 'Changed elsewhere; reload and try again';
const job = {
  company: 'Northwind Labs',
  role: 'Staff engineer',
  location: 'Remote',
  startsOn: '2022-03-01',
  endsOn: null as string | null,
  summaryMd: 'Led the **billing** rewrite.',
};
const ledger = {
  name: 'Ledger',
  description: 'Double-entry billing engine.',
  url: 'https://ledger.example/' as string | null,
  repoUrl: 'https://code.example/aiko/ledger' as string | null,
  tags: ['postgres', 'billing'],
};

type Item = { id: string; updatedAt: string } & Record<string, unknown>;
type Kind = {
  noun: string;
  body: Record<string, unknown>;
  cap: number;
  rows: (tx: TenantTransaction) => Promise<({ id: string } & Record<string, unknown>)[]>;
  fill: (tx: TenantTransaction, tenantId: string, count: number) => Promise<unknown>;
  edit: Record<string, unknown>;
  invalid: [string, Record<string, unknown>];
  refusals: [string, unknown][];
};

const over = (max: number) => 'a'.repeat(max + 1);
const experienceItems: Kind = {
  noun: 'experiences',
  body: job,
  cap: LIMITS.experiences,
  rows: (tx) => tx.select().from(experiences).orderBy(experiences.id),
  fill: (tx, tenantId, count) =>
    tx.insert(experiences).values(Array(count).fill({ ...job, tenantId })),
  edit: { role: 'Principal' },
  invalid: ['an end before the start', { endsOn: '2022-02-28' }],
  refusals: [
    ['a missing field', { company: 'Northwind Labs' }],
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
  ],
};
const projectItems: Kind = {
  noun: 'projects',
  body: ledger,
  cap: LIMITS.projects,
  rows: (tx) => tx.select().from(projects).orderBy(projects.id),
  fill: (tx, tenantId, count) =>
    tx.insert(projects).values(Array(count).fill({ ...ledger, tenantId })),
  edit: { name: 'Ledger 2' },
  invalid: ['a javascript: url', { url: 'javascript:alert(1)' }],
  refusals: [
    ['a missing field', { name: 'Ledger' }],
    ['an empty name', { ...ledger, name: '' }],
    ['an over-long name', { ...ledger, name: over(LIMITS.projectName) }],
    ['an over-long description', { ...ledger, description: over(LIMITS.description) }],
    ['a javascript: url', { ...ledger, url: 'javascript:alert(1)' }],
    ['a data: url', { ...ledger, url: 'data:text/html,<script>alert(1)</script>' }],
    ['a mailto: url', { ...ledger, url: 'mailto:aiko@example.test' }],
    ['an empty url', { ...ledger, url: '' }],
    ['an over-long url', { ...ledger, url: `https://ledger.example/${over(LIMITS.url)}` }],
    ['an http: repo url', { ...ledger, repoUrl: 'http://code.example/aiko/ledger' }],
    ['a protocol-relative repo url', { ...ledger, repoUrl: '//code.example/aiko/ledger' }],
    ['a repo url with credentials', { ...ledger, repoUrl: 'https://aiko:token@code.example/' }],
    ['13 tags', { ...ledger, tags: Array.from({ length: LIMITS.tags + 1 }, (_, i) => `t${i}`) }],
    ['an over-long tag', { ...ledger, tags: [over(LIMITS.tag)] }],
    ['an empty tag', { ...ledger, tags: [''] }],
    ['tags as a string', { ...ledger, tags: 'postgres' }],
  ],
};
const kinds = [experienceItems, projectItems];

const pathOf = (kind: Kind) => `/api/v1/me/${kind.noun}`;
const item = (kind: Kind, id: string) => `${pathOf(kind)}/${id}`;

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

function create(kind: Kind, name: Person, body: unknown, key: string | null = randomUUID()) {
  return send('POST', pathOf(kind), { body, cookie: session[name].cookie, key: key ?? undefined });
}

function everyRoute(
  kind: Kind,
  cookie: string | undefined,
  id: string,
  updatedAt: string,
  extra = {},
) {
  const { body } = kind;
  return Promise.all([
    send('GET', pathOf(kind), { cookie }),
    send('POST', pathOf(kind), { cookie, body: { ...body, ...extra }, key: randomUUID() }),
    send('GET', item(kind, id), { cookie }),
    send('PUT', item(kind, id), { cookie, body: { ...body, updatedAt, ...extra } }),
    send('DELETE', item(kind, id), { cookie, body: { updatedAt, ...extra } }),
  ]);
}

async function expectRefused(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error, requestId: res.headers.get('x-request-id') });
}

function asUser<T>(name: Person, fn: Parameters<typeof withTenant<T>>[2]) {
  return withTenant({ pool: app }, { kind: 'user', userId: session[name].id }, fn);
}

function rowsOf(kind: Kind, name: Person) {
  return asUser(name, (tx) => kind.rows(tx));
}

async function seed(kind: Kind, name: Person): Promise<Item> {
  const res = await create(kind, name, kind.body);
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
    await asUser(name, async (tx) => {
      await tx.delete(experiences);
      await tx.delete(projects);
    });
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
    const res = await create(experienceItems, 'aiko', hostile, key);
    expect(res.status).toBe(201);
    const newer = await res.json();
    expect(newer).toEqual({ id: key, ...hostile, updatedAt: expect.any(String) });
    const older = await (
      await create(experienceItems, 'aiko', { ...job, startsOn: '2018-01-01' })
    ).json();
    await seed(experienceItems, 'bruno');
    const { cookie } = session.aiko;
    const list = await send('GET', pathOf(experienceItems), { cookie });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([newer, older]);
    expect(await (await send('GET', item(experienceItems, key), { cookie })).json()).toEqual(newer);
  });
});

describe('/api/v1/me/projects', () => {
  it('creates under the idempotency key, lists newest first and reads hostile text and 12 tags verbatim', async () => {
    const hostile = {
      ...ledger,
      name: "Ledger'); drop table projects; --",
      description: '<script>alert(1)</script>',
      url: "https://ledger.example/?q='--",
      repoUrl: null,
      tags: Array.from({ length: LIMITS.tags }, (_, i) => `<b>${i}</b>`),
    };
    const [first, second] = [randomUUID(), randomUUID()].sort();
    const res = await create(projectItems, 'aiko', hostile, first);
    expect(res.status).toBe(201);
    const older = await res.json();
    expect(older).toEqual({ id: first, ...hostile, updatedAt: expect.any(String) });
    const newer = await (await create(projectItems, 'aiko', ledger, second)).json();
    await seed(projectItems, 'bruno');
    const { cookie } = session.aiko;
    const list = await send('GET', pathOf(projectItems), { cookie });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([newer, older]);
    expect(await (await send('GET', item(projectItems, first), { cookie })).json()).toEqual(older);
  });
});

describe.each(kinds)('/api/v1/me/$noun items', (kind) => {
  const { body, cap, noun } = kind;

  it('answers a double submit and concurrent repeats of one key with the one row it created', async () => {
    const key = randomUUID();
    const first = await create(kind, 'aiko', body, key);
    const second = await create(kind, 'aiko', { ...body, ...kind.edit }, key);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(await second.json()).toEqual(await first.json());
    const racing = randomUUID();
    const raced = await Promise.all([1, 2, 3].map(() => create(kind, 'aiko', body, racing)));
    expect(raced.map((res) => res.status)).toEqual([201, 201, 201]);
    expect((await rowsOf(kind, 'aiko')).map((row) => row.id)).toEqual([key, racing].sort());
  });

  it("refuses a key that is another tenant's item id with 409 and changes nothing", async () => {
    const theirs = await seed(kind, 'bruno');
    const before = await rowsOf(kind, 'bruno');
    await expectRefused(await create(kind, 'aiko', body, theirs.id), 409, 'Conflict');
    expect(await rowsOf(kind, 'aiko')).toEqual([]);
    expect(await rowsOf(kind, 'bruno')).toEqual(before);
  });

  it(`lets one of four concurrent creates take place ${cap} and answers its key after`, async () => {
    await asUser('dana', (tx, tenantId) => kind.fill(tx, tenantId ?? '', cap - 1));
    const keys = [1, 2, 3, 4].map(() => randomUUID());
    const results = await Promise.all(keys.map((key) => create(kind, 'dana', body, key)));
    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409, 409]);
    const refused = results.find((res) => res.status === 409);
    if (refused === undefined) throw new Error('no refused create');
    await expectRefused(refused, 409, `You can keep at most ${cap} ${noun}`);
    const winner = keys[results.findIndex((res) => res.status === 201)];
    expect((await create(kind, 'dana', body, winner)).status).toBe(201);
    expect(await rowsOf(kind, 'dana')).toHaveLength(cap);
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
    const res = await create(kind, 'aiko', body);
    release.resolve();
    await holder;
    await expectRefused(res, 503, 'Service unavailable');
    expect(await rowsOf(kind, 'aiko')).toEqual([]);
  });

  it.each<[string, unknown, (string | null)?]>([
    ['no key', body, null],
    ['a key that is not a uuid', body, 'submit-1'],
    ['a SQL key', body, "1' or '1'='1"],
    ['an id', { ...body, id: randomUUID() }],
    ['a tenant_id', { ...body, tenant_id: randomUUID() }],
    ['a tenantId', { ...body, tenantId: randomUUID() }],
    ['an owner_id', { ...body, owner_id: randomUUID() }],
    ['an updatedAt', { ...body, updatedAt: '2026-10-13 10:00:00.123456+00' }],
    ['a createdAt', { ...body, createdAt: '2026-10-13 10:00:00.123456+00' }],
    ['an unknown key', { ...body, featured: true }],
    ['a prototype key', `{"__proto__":{"admin":true},${JSON.stringify(body).slice(1)}`],
    ['an array body', [body]],
    ...kind.refusals,
  ])('refuses a create with %s with 400 and creates nothing', async (_, sent, key) => {
    await expectRefused(await create(kind, 'aiko', sent, key), 400, 'Bad request');
    expect(await rowsOf(kind, 'aiko')).toEqual([]);
  });

  it('saves with the loaded token and refuses a second tab or a token one microsecond off', async () => {
    const loaded = await seed(kind, 'aiko');
    const { cookie } = session.aiko;
    const res = await send('PUT', item(kind, loaded.id), {
      cookie,
      body: { ...body, ...kind.edit, updatedAt: loaded.updatedAt },
    });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved).toEqual({ ...loaded, ...kind.edit, updatedAt: expect.any(String) });
    expect(saved.updatedAt).not.toBe(loaded.updatedAt);
    const [{ later }] = await rows<{ later: string }>(drizzle(app))(
      sql`select (${saved.updatedAt}::timestamptz + interval '1 microsecond')::text as later`,
    );
    const kept = await rowsOf(kind, 'aiko');
    for (const updatedAt of [loaded.updatedAt, later]) {
      const sent = { ...body, updatedAt };
      await expectRefused(
        await send('PUT', item(kind, loaded.id), { cookie, body: sent }),
        409,
        stale,
      );
      const removed = await send('DELETE', item(kind, loaded.id), { cookie, body: { updatedAt } });
      await expectRefused(removed, 409, stale);
    }
    expect(await rowsOf(kind, 'aiko')).toEqual(kept);
  });

  it('deletes with the loaded token, then answers 404 and creates the key again with a new token', async () => {
    const first = await seed(kind, 'aiko');
    const { cookie } = session.aiko;
    const token = { updatedAt: first.updatedAt };
    const res = await send('DELETE', item(kind, first.id), { cookie, body: token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: first.id });
    expect(await rowsOf(kind, 'aiko')).toEqual([]);
    const sent = { ...body, ...token };
    await expectRefused(
      await send('PUT', item(kind, first.id), { cookie, body: sent }),
      404,
      'Not found',
    );
    await expectRefused(
      await send('DELETE', item(kind, first.id), { cookie, body: token }),
      404,
      'Not found',
    );
    const again = await create(kind, 'aiko', body, first.id);
    expect(again.status).toBe(201);
    expect((await again.json()).updatedAt).not.toBe(first.updatedAt);
    await expectRefused(
      await send('PUT', item(kind, first.id), { cookie, body: sent }),
      409,
      stale,
    );
  });

  const [invalidName, invalid] = kind.invalid;
  it.each([
    ['PUT', 'no token', () => body],
    ['PUT', 'a malformed token', () => ({ ...body, updatedAt: '2026-10-13T10:00:00.123Z' })],
    ['PUT', 'an id', (updatedAt: string) => ({ ...body, updatedAt, id: randomUUID() })],
    [
      'PUT',
      'a tenant_id',
      (updatedAt: string) => ({ ...body, updatedAt, tenant_id: randomUUID() }),
    ],
    ['PUT', invalidName, (updatedAt: string) => ({ ...body, updatedAt, ...invalid })],
    ['DELETE', 'no body', () => undefined],
    ['DELETE', 'no token', () => ({})],
    ['DELETE', 'an extra key', (updatedAt: string) => ({ updatedAt, id: randomUUID() })],
  ])('refuses a %s with %s with 400 and changes nothing', async (method, _, bodyOf) => {
    const loaded = await seed(kind, 'aiko');
    const before = await rowsOf(kind, 'aiko');
    const sent = bodyOf(loaded.updatedAt);
    const res = await send(method, item(kind, loaded.id), {
      cookie: session.aiko.cookie,
      body: sent,
    });
    await expectRefused(res, 400, 'Bad request');
    expect(await rowsOf(kind, 'aiko')).toEqual(before);
  });

  it("answers 404 for another tenant's, unknown, malformed and SQL ids and changes nothing", async () => {
    const theirs = await seed(kind, 'bruno');
    const before = await rowsOf(kind, 'bruno');
    const { cookie } = session.aiko;
    for (const id of [theirs.id, randomUUID(), 'not-a-uuid', "1'%20or%20'1'='1"]) {
      const answered = await everyRoute(kind, cookie, id, theirs.updatedAt);
      expect(
        answered.slice(2).map((res) => res.status),
        id,
      ).toEqual([404, 404, 404]);
    }
    expect(await rowsOf(kind, 'bruno')).toEqual(before);
  });
});

describe.each(kinds)('actors other than the owner on /api/v1/me/$noun', (kind) => {
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
    const loaded = await seed(kind, 'aiko');
    const before = await rowsOf(kind, 'aiko');
    const error = status === 401 ? 'Unauthorized' : 'Not found';
    for (const res of await everyRoute(kind, cookie(), loaded.id, loaded.updatedAt, extra)) {
      await expectRefused(res, status, error);
    }
    expect(await rowsOf(kind, 'aiko')).toEqual(before);
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
      const loaded = await seed(kind, 'aiko');
      const before = await rowsOf(kind, 'aiko');
      const res = await send(method, method === 'POST' ? pathOf(kind) : item(kind, loaded.id), {
        body: `company=Mallory&updatedAt=${encodeURIComponent(loaded.updatedAt)}`,
        cookie: session.aiko.cookie,
        type,
        origin,
        key: randomUUID(),
      });
      await expectRefused(res, 403, 'Forbidden');
      expect(await rowsOf(kind, 'aiko')).toEqual(before);
    },
  );
});
