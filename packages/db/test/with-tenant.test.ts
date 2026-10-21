import { sql } from 'drizzle-orm';
import { PgDatabase, PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect, connectionOptions } from '../src/client.ts';
import { experiences } from '../src/schema/content.ts';
import { tenants } from '../src/schema/tenants.ts';
import {
  type TenantContext,
  type TenantTransaction,
  tenantDatabase,
  withTenant,
} from '../src/with-tenant.ts';
import { createTenant, createUser, deleteUsers, requireWritable } from './fixtures.ts';
import { roleUrl } from './setup.ts';

const { appUrl, authUrl } = inject('db');
const app = connect(appUrl);
const auth = connect(authUrl);
const statements: { query: string; params: unknown[] }[] = [];
const db = drizzle(app, {
  logger: { logQuery: (query, params) => statements.push({ query, params }) },
});
const owner = { userId: '', tenantId: '' };
const other = { userId: '', tenantId: '' };
let newcomer = '';

const rollback = new Error('rolled back');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(async () => {
  requireWritable();
  owner.userId = await createUser(auth, 'Amara Diallo', 'amara@example.test');
  other.userId = await createUser(auth, 'Kenji Mori', 'kenji@example.test');
  newcomer = await createUser(auth, 'Lena Fischer', 'lena@example.test');
  owner.tenantId = await createTenant(db, owner.userId, 'amara');
  other.tenantId = await createTenant(db, other.userId, 'kenji');
});

afterAll(async () => {
  await deleteUsers(auth, [owner.userId, other.userId, newcomer]);
  await Promise.all([app.end(), auth.end()]);
});

type Seen = { tenant: string | null; user: string | null; owner: boolean };

async function context(tx: TenantTransaction): Promise<Seen> {
  const [seen] = await tx.execute<Seen>(
    sql`select app.tenant_id() as tenant, app.user_id() as user, app.is_owner() as owner`,
  );
  return seen;
}

describe('withTenant', () => {
  it('sets the user with no tenant, then the tenant from its lookup, all before fn runs', async () => {
    statements.length = 0;
    const seen = await withTenant(
      db,
      { kind: 'user', userId: owner.userId },
      async (tx, tenantId) => {
        expect(tenantId).toBe(owner.tenantId);
        return context(tx);
      },
    );
    expect(seen).toEqual({ tenant: owner.tenantId, user: owner.userId, owner: true });
    expect(statements.map(({ params }) => params)).toEqual([[owner.userId], [], []]);
    expect(statements[0].query).toMatch(/set_config\('app\.tenant_id', '', true\)/);
    expect(statements[1].query).toMatch(
      /^select nullif\(set_config\('app\.tenant_id', coalesce\(\(select id::text from public\.tenants where owner_id = app\.user_id\(\)\), ''\), true\), ''\)/,
    );
  });

  it('runs the owner context, not onboarding, when onboarding is present but not true', async () => {
    const tenantId = await withTenant(
      db,
      { kind: 'user', userId: owner.userId, onboarding: undefined },
      async (_tx, id) => id,
    );
    expect(tenantId).toBe(owner.tenantId);
  });

  it('runs fn with no tenant for a user who has none yet', async () => {
    const seen = await withTenant(db, { kind: 'user', userId: newcomer }, async (tx, tenantId) => {
      expect(tenantId).toBeNull();
      expect(await tx.select().from(tenants)).toEqual([]);
      return context(tx);
    });
    expect(seen).toEqual({ tenant: null, user: newcomer, owner: false });
  });

  it('gives onboarding a fresh tenant id that no row holds, owned once inserted', async () => {
    statements.length = 0;
    const ids: (string | null)[] = [];
    await expect(
      withTenant(db, { kind: 'user', userId: newcomer, onboarding: true }, async (tx, tenantId) => {
        ids.push(tenantId);
        expect(tenantId).toMatch(uuid);
        expect(await tx.select().from(tenants)).toEqual([]);
        expect(await context(tx)).toEqual({ tenant: tenantId, user: newcomer, owner: false });
        await tx
          .insert(tenants)
          .values({ id: tenantId ?? '', subdomain: 'lena', ownerId: newcomer });
        expect(await context(tx)).toEqual({ tenant: tenantId, user: newcomer, owner: true });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(statements[0].params).toEqual([newcomer]);
    expect(statements.filter(({ query }) => query.includes('public.tenants'))).toEqual([]);
    ids.push(
      await withTenant(
        db,
        { kind: 'user', userId: newcomer, onboarding: true },
        async (_tx, id) => id,
      ),
    );
    expect(new Set([...ids, owner.tenantId, other.tenantId]).size).toBe(4);
    expect(
      await withTenant(db, { kind: 'user', userId: newcomer }, async (_tx, tenantId) => tenantId),
    ).toBeNull();
  });

  it('sets no user and no tenant in the job context', async () => {
    statements.length = 0;
    const seen = await withTenant(db, { kind: 'job' }, async (tx, tenantId) => {
      expect(tenantId).toBeNull();
      return context(tx);
    });
    expect(seen).toEqual({ tenant: null, user: null, owner: false });
    expect(statements.map(({ params }) => params)).toEqual([[null], []]);
  });

  it('marks only the job context as the domain re-check job', async () => {
    const marker = (context: TenantContext) =>
      withTenant(db, context, async (tx) => {
        const [row] = await tx.execute<{ job: string | null }>(
          sql`select current_setting('app.job', true) as job`,
        );
        return row.job;
      });
    expect(await marker({ kind: 'job' })).toBe('domain-recheck');
    expect(await marker({ kind: 'site', site: 'amara' })).toBe('');
    expect(await marker({ kind: 'user', userId: owner.userId })).toBe('');
    expect(await marker({ kind: 'user', userId: newcomer, onboarding: true })).toBe('');
  });

  it('refuses a context that mixes shapes, before sending anything', async () => {
    const session = { kind: 'user' as const, userId: other.userId };
    const spread: TenantContext = { ...session, kind: 'site', site: 'nobody.example' };
    const mixed: [string, unknown][] = [
      ['a session spread into an unknown site', spread],
      ['a site with its owner', { kind: 'site', site: 'amara', userId: owner.userId }],
      ['a user with a site', { kind: 'user', userId: other.userId, site: 'amara' }],
      [
        'onboarding with a site',
        { kind: 'user', userId: newcomer, onboarding: true, site: 'amara' },
      ],
      ['the job with a user', { kind: 'job', userId: owner.userId }],
      ['the job with a site', { kind: 'job', site: 'amara' }],
      ['a site without a kind', { site: 'amara' }],
      ['a user without a kind', { userId: owner.userId }],
      ['an unknown kind', { kind: 'admin' }],
      ['onboarding set to false', { kind: 'user', userId: newcomer, onboarding: false }],
      ['a user id that is not a string', { kind: 'user', userId: 7 }],
    ];
    for (const [what, context] of mixed) {
      statements.length = 0;
      let ran = false;
      await expect(
        withTenant(db, context as never, async () => {
          ran = true;
        }),
        what,
      ).rejects.toEqual(new TypeError('withTenant takes exactly one context shape'));
      expect({ what, ran, sent: statements.length }).toEqual({ what, ran: false, sent: 0 });
    }
  });

  it('resolves the site key with no user, in a read-only transaction, before fn runs', async () => {
    statements.length = 0;
    const seen = await withTenant(db, { kind: 'site', site: 'amara' }, async (tx, tenantId) => {
      expect(tenantId).toBe(owner.tenantId);
      return context(tx);
    });
    expect(seen).toEqual({ tenant: owner.tenantId, user: null, owner: false });
    expect(statements.map(({ params }) => params)).toEqual([[], [null, 'amara'], []]);
    expect(statements[0].query).toBe('set transaction isolation level repeatable read read only');
    expect(statements[1].query).toMatch(/coalesce\(app\.resolve_site\(\$2::text\)::text, ''\)/);
  });

  it.each([
    'AMARA',
    'amara.',
    'amar',
    'amara%',
    '',
    "amara' or '1'='1",
    "amara'); select pg_sleep(1); --",
    'nobody.example',
  ])('runs fn with no tenant and shows nothing for the unresolved site key %j', async (site) => {
    const seen = await withTenant(db, { kind: 'site', site }, async (tx, tenantId) => ({
      tenantId,
      context: await context(tx),
      visible: await tx.$count(tenants),
    }));
    expect(seen).toEqual({
      tenantId: null,
      context: { tenant: null, user: null, owner: false },
      visible: 0,
    });
  });

  it.each<[string, () => TenantContext, { isolation: string; readOnly: string }]>([
    [
      'site',
      () => ({ kind: 'site', site: 'amara' }),
      { isolation: 'repeatable read', readOnly: 'on' },
    ],
    [
      'owner',
      () => ({ kind: 'user', userId: owner.userId }),
      { isolation: 'read committed', readOnly: 'off' },
    ],
    ['job', () => ({ kind: 'job' }), { isolation: 'read committed', readOnly: 'off' }],
  ])('runs the %s context at its own isolation level', async (_name, input, expected) => {
    const level = await withTenant(db, input(), async (tx) => {
      const [row] = await tx.execute<{ isolation: string; readOnly: string }>(
        sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as "readOnly"`,
      );
      return row;
    });
    expect(level).toEqual(expected);
  });

  it('keeps the site context on the snapshot of its first read while the owner commits', async () => {
    const asAmara = { kind: 'user', userId: owner.userId } as const;
    const counts = await withTenant(db, { kind: 'site', site: 'amara' }, async (tx) => {
      const before = await tx.$count(experiences);
      await withTenant(db, asAmara, (owned) =>
        owned.insert(experiences).values({
          tenantId: owner.tenantId,
          company: 'Fabrikam',
          role: 'Engineer',
          startsOn: '2020-01-01',
        }),
      );
      return { before, after: await tx.$count(experiences) };
    });
    const committed = await withTenant(db, asAmara, async (owned) => {
      const visible = await owned.$count(experiences);
      await owned.delete(experiences);
      return visible;
    });
    expect({ ...counts, committed }).toEqual({ before: 0, after: 0, committed: 1 });
  });

  it('refuses every write in the site context, also to the tenant it resolved', async () => {
    await expect(
      withTenant(db, { kind: 'site', site: 'amara' }, (tx) =>
        tx
          .insert(tenants)
          .values({ id: owner.tenantId, subdomain: 'amara', ownerId: owner.userId }),
      ),
    ).rejects.toMatchObject({ cause: { code: '25006' } });
  });

  it('bounds statements, lock waits and idle time inside the transaction', async () => {
    const limits = await withTenant(db, { kind: 'job' }, async (tx) => {
      const [row] = await tx.execute(
        sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock, current_setting('idle_in_transaction_session_timeout') as idle`,
      );
      return row;
    });
    expect(limits).toEqual({ statement: '5s', lock: '2s', idle: '10s' });
    await expect(
      withTenant(db, { kind: 'job' }, (tx) => tx.execute(sql`select pg_sleep(10)`)),
    ).rejects.toMatchObject({ cause: { code: '57014' } });
  });

  async function onPoolOfOne<T>(run: (pooled: PostgresJsDatabase, single: Sql) => Promise<T>) {
    const single = postgres({ ...connectionOptions(appUrl, process.env), max: 1 });
    try {
      return await run(drizzle(single), single);
    } finally {
      await single.end();
    }
  }

  it('gives up waiting for a lock another transaction holds', async () => {
    const key = 4242;
    await auth.begin(async (holder) => {
      await holder`select pg_advisory_xact_lock(${key})`;
      await expect(
        withTenant(db, { kind: 'job' }, (tx) =>
          tx.execute(sql`select pg_advisory_xact_lock(${key})`),
        ),
      ).rejects.toMatchObject({ cause: { code: '55P03' } });
    });
  });

  it('ends a transaction left idle inside fn', async () => {
    await onPoolOfOne(async (pooled) => {
      const idle = withTenant(pooled, { kind: 'job' }, async (tx) => {
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        await vi.waitFor(
          async () => {
            const [{ gone }] = await auth<{ gone: boolean }[]>`
              select not exists (select from pg_stat_activity where pid = ${pid}) as gone
            `;
            expect(gone).toBe(true);
          },
          { timeout: 20_000, interval: 500 },
        );
        return tx.execute(sql`select 1`);
      });
      await expect(idle).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
    });
  });

  it('leaves no context or timeout behind on a pool of one connection', async () => {
    const session = sql`select pg_backend_pid() as pid, app.tenant_id() as tenant, app.user_id() as user, current_setting('statement_timeout') as timeout, (select count(*)::int from tenants) as visible`;
    await onPoolOfOne(async (pooled) => {
      const [before] = await pooled.execute(session);
      expect(before).toMatchObject({ tenant: null, user: null, visible: 0 });
      const [inside] = await withTenant(pooled, { kind: 'user', userId: other.userId }, (tx) =>
        tx.execute(session),
      );
      expect(inside).toEqual({
        ...before,
        tenant: other.tenantId,
        user: other.userId,
        timeout: '5s',
        visible: 1,
      });
      expect((await pooled.execute(session))[0]).toEqual(before);
    });
  });

  it('lets no temporary table shadow the tenant lookup on a pool of one connection', async () => {
    await onPoolOfOne(async (pooled, single) => {
      await expect(
        single`create temp table tenants (id uuid, owner_id uuid)`,
      ).rejects.toMatchObject({ code: '42501' });
      expect(
        await withTenant(pooled, { kind: 'user', userId: owner.userId }, async (_tx, id) => id),
      ).toBe(owner.tenantId);
    });
  });

  it('hands fn a plain object, never a drizzle transaction', async () => {
    const tx = await withTenant(db, { kind: 'user', userId: owner.userId }, async (tx) => tx);
    expect(tx).not.toBeInstanceOf(PgTransaction);
    expect(['setTransaction', 'transaction', '_', 'session'].filter((key) => key in tx)).toEqual(
      [],
    );
    expect(Object.keys(tx).sort()).toEqual([
      '$count',
      'delete',
      'execute',
      'insert',
      'select',
      'update',
    ]);
  });

  it('gives app code a handle whose only member is withTenant', async () => {
    const handle = tenantDatabase(appUrl);
    expect(handle).not.toBeInstanceOf(PgDatabase);
    expect(Object.keys(handle)).toEqual(['withTenant']);
    expect(
      await handle.withTenant({ kind: 'user', userId: owner.userId }, async (_tx, id) => id),
    ).toBe(owner.tenantId);
  });

  // U& spells set_config past the repository guard, as a hostile string would.
  const hostile = () =>
    String.raw`select 1; select U&"set\005fconfig"('app.tenant_id', '${other.tenantId}', true)`;

  it.each([
    ['a string cast past the types', (tx: TenantTransaction) => tx.execute(hostile() as never)],
    [
      'a string through Reflect.apply',
      (tx: TenantTransaction) => Reflect.apply(tx.execute, tx, [hostile()]),
    ],
    [
      'a getSQL wrapper returning a string',
      (tx: TenantTransaction) => tx.execute({ getSQL: () => hostile() as never }),
    ],
  ])('refuses %s in execute before sending anything', async (_name, attack) => {
    const outcome = await withTenant(db, { kind: 'user', userId: owner.userId }, async (tx) => {
      const before = statements.length;
      const thrown = await Promise.resolve()
        .then(() => attack(tx))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const sent = statements.slice(before);
      const [seen] = await tx.execute<{ visible: number }>(
        sql`select count(*)::int as visible from public.tenants where id = ${other.tenantId}`,
      );
      return { thrown, sent, visible: seen.visible };
    });
    expect(outcome).toEqual({
      thrown: new TypeError('execute takes drizzle SQL only'),
      sent: [],
      visible: 0,
    });
  });

  const hostileIds = [
    "' or 1=1 --",
    'not-a-uuid',
    '00000000-0000-0000-0000-000000000000; select 1',
    "00000000-0000-0000-0000-000000000000', true) --",
  ];

  it.each(hostileIds)(
    'refuses the hostile user id %j before sending anything, as owner and in onboarding',
    async (userId) => {
      let ran = false;
      for (const context of [
        { kind: 'user' as const, userId },
        { kind: 'user' as const, userId, onboarding: true as const },
      ]) {
        statements.length = 0;
        await expect(
          withTenant(db, context, async () => {
            ran = true;
          }),
        ).rejects.toEqual(new TypeError('withTenant takes exactly one context shape'));
        expect(statements).toEqual([]);
      }
      expect(ran).toBe(false);
    },
  );

  it('runs the context it checked, even when a getter changes its kind after one read', async () => {
    for (let userReads = 1; userReads <= 8; userReads += 1) {
      let reads = 0;
      const context = {
        userId: owner.userId,
        get kind() {
          reads += 1;
          return reads <= userReads ? 'user' : 'job';
        },
      };
      const outcome = await withTenant(db, context as never, async (tx) => {
        const [row] = await tx.execute<{ user: string | null; job: string }>(
          sql`select app.user_id() as user, current_setting('app.job', true) as job`,
        );
        return row;
      }).catch((error: unknown) => error);
      expect([
        new TypeError('withTenant takes exactly one context shape'),
        { user: owner.userId, job: '' },
      ]).toContainEqual(outcome);
    }
  });
});

describe.runIf(inject('db').mode === 'local')(
  'a tenant database on a role that bypasses row-level security',
  () => {
    const { ownerUrl } = inject('db');
    const probe = postgres({ ...connectionOptions(ownerUrl, process.env), onnotice: () => {} });
    const probePassword = 'probe-password-not-secret-0000000';
    const probeUrl = roleUrl(ownerUrl, 'ff_bypass_probe', probePassword);
    const refusal = new Error('withTenant refuses a database role with SUPERUSER or BYPASSRLS');
    const rejection = (work: Promise<unknown>) => work.catch((error: unknown) => error);

    beforeAll(async () => {
      await probe`drop role if exists ff_bypass_probe`;
      await probe.begin(async (tx) => {
        await tx`
          create function pg_temp.create_bypass_probe(secret text) returns void
          language plpgsql as $$
          begin
            execute format('create role ff_bypass_probe login nobypassrls password %L', secret);
          end
          $$
        `;
        await tx`select pg_temp.create_bypass_probe(${probePassword})`;
      });
    });

    afterAll(async () => {
      await probe`drop role if exists ff_bypass_probe`;
      await probe.end();
    });

    it('refuses the owner role before fn reads any tenant, on every call', async () => {
      const handle = tenantDatabase(ownerUrl);
      const read = vi.fn(async (tx: TenantTransaction) => tx.select().from(tenants));
      const { username, password, hostname } = new URL(ownerUrl);
      for (let call = 0; call < 2; call += 1) {
        const thrown = await rejection(handle.withTenant({ kind: 'job' }, read));
        expect(thrown).toEqual(refusal);
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        for (const part of [ownerUrl, username, password, hostname]) {
          expect(message).not.toContain(part);
        }
      }
      expect(read).not.toHaveBeenCalled();
    });

    it('runs one role check for concurrent first calls on a handle', async () => {
      const handle = tenantDatabase(ownerUrl);
      const read = vi.fn(async () => 'read');
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => rejection(handle.withTenant({ kind: 'job' }, read))),
      );
      expect([...new Set(outcomes)]).toEqual([refusal]);
      expect(read).not.toHaveBeenCalled();
    });

    it('checks the role once per handle: a later BYPASSRLS grant shows only on a new handle', async () => {
      const handle = tenantDatabase(probeUrl);
      const seen = () => handle.withTenant({ kind: 'job' }, async (_tx, tenantId) => tenantId);
      expect(await seen()).toBeNull();
      await probe`alter role ff_bypass_probe bypassrls`;
      expect(await seen()).toBeNull();
      await expect(
        tenantDatabase(probeUrl).withTenant({ kind: 'job' }, async () => 'read'),
      ).rejects.toEqual(refusal);
    });

    it('keeps no role check that errored: the next call checks again', async () => {
      await probe`alter role ff_bypass_probe nologin bypassrls`;
      const handle = tenantDatabase(probeUrl);
      const read = vi.fn(async (_tx: TenantTransaction, tenantId: string | null) => tenantId);
      expect(await rejection(handle.withTenant({ kind: 'job' }, read))).toMatchObject({
        code: '28000',
      });
      await probe`alter role ff_bypass_probe login`;
      await expect(handle.withTenant({ kind: 'job' }, read)).rejects.toEqual(refusal);
      expect(read).not.toHaveBeenCalled();
      await probe`alter role ff_bypass_probe nobypassrls`;
      expect(await handle.withTenant({ kind: 'job' }, read)).toBeNull();
    });
  },
);
