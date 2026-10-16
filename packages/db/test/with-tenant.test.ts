import { sql } from 'drizzle-orm';
import { PgDatabase, PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect, connectionOptions } from '../src/client.ts';
import { tenants } from '../src/schema/tenants.ts';
import { type TenantTransaction, tenantDatabase, withTenant } from '../src/with-tenant.ts';
import { createTenant, createUser, deleteUsers, requireWritable } from './fixtures.ts';

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
    const seen = await withTenant(db, { userId: owner.userId }, async (tx, tenantId) => {
      expect(tenantId).toBe(owner.tenantId);
      return context(tx);
    });
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
      { userId: owner.userId, onboarding: undefined },
      async (_tx, id) => id,
    );
    expect(tenantId).toBe(owner.tenantId);
  });

  it('runs fn with no tenant for a user who has none yet', async () => {
    const seen = await withTenant(db, { userId: newcomer }, async (tx, tenantId) => {
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
      withTenant(db, { userId: newcomer, onboarding: true }, async (tx, tenantId) => {
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
    ids.push(await withTenant(db, { userId: newcomer, onboarding: true }, async (_tx, id) => id));
    expect(new Set([...ids, owner.tenantId, other.tenantId]).size).toBe(4);
    expect(
      await withTenant(db, { userId: newcomer }, async (_tx, tenantId) => tenantId),
    ).toBeNull();
  });

  it('sets no user and no tenant in the job context', async () => {
    statements.length = 0;
    const seen = await withTenant(db, { job: 'domain-recheck' }, async (tx, tenantId) => {
      expect(tenantId).toBeNull();
      return context(tx);
    });
    expect(seen).toEqual({ tenant: null, user: null, owner: false });
    expect(statements.map(({ params }) => params)).toEqual([[null], []]);
  });

  it('bounds statements, lock waits and idle time inside the transaction', async () => {
    const limits = await withTenant(db, { job: 'domain-recheck' }, async (tx) => {
      const [row] = await tx.execute(
        sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock, current_setting('idle_in_transaction_session_timeout') as idle`,
      );
      return row;
    });
    expect(limits).toEqual({ statement: '5s', lock: '2s', idle: '10s' });
    await expect(
      withTenant(db, { job: 'domain-recheck' }, (tx) => tx.execute(sql`select pg_sleep(10)`)),
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
        withTenant(db, { job: 'domain-recheck' }, (tx) =>
          tx.execute(sql`select pg_advisory_xact_lock(${key})`),
        ),
      ).rejects.toMatchObject({ cause: { code: '55P03' } });
    });
  });

  it('ends a transaction left idle inside fn', async () => {
    await onPoolOfOne(async (pooled) => {
      const idle = withTenant(pooled, { job: 'domain-recheck' }, async (tx) => {
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
      const [inside] = await withTenant(pooled, { userId: other.userId }, (tx) =>
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
      expect(await withTenant(pooled, { userId: owner.userId }, async (_tx, id) => id)).toBe(
        owner.tenantId,
      );
    });
  });

  it('hands fn a plain object, never a drizzle transaction', async () => {
    const tx = await withTenant(db, { userId: owner.userId }, async (tx) => tx);
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
    expect(await handle.withTenant({ userId: owner.userId }, async (_tx, id) => id)).toBe(
      owner.tenantId,
    );
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
    const outcome = await withTenant(db, { userId: owner.userId }, async (tx) => {
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
    'refuses the hostile user id %j before fn runs, as owner and in onboarding',
    async (userId) => {
      let ran = false;
      for (const context of [{ userId }, { userId, onboarding: true as const }]) {
        await expect(
          withTenant(db, context, async () => {
            ran = true;
          }),
        ).rejects.toMatchObject({ cause: { code: '22P02' } });
      }
      expect(ran).toBe(false);
    },
  );
});
