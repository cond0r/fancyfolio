import { is, type Logger, SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgQueryResultKind, PgSelectBuilder, SelectedFields } from 'drizzle-orm/pg-core';
import type { PgRaw } from 'drizzle-orm/pg-core/query-builders/raw';
import type { Pool } from 'pg';
import * as v from 'valibot';
import { connect, logConnectionError } from './client.ts';

const contextSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('user'),
    userId: v.pipe(v.string(), v.uuid()),
    onboarding: v.optional(v.literal(true)),
  }),
  v.strictObject({ kind: v.literal('site'), site: v.string() }),
  v.strictObject({ kind: v.literal('job') }),
]);

export type TenantContext = v.InferInput<typeof contextSchema>;

export type TenantTransaction = Pick<
  NodePgDatabase,
  'select' | 'insert' | 'update' | 'delete' | '$count'
> & {
  execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    query: SQLWrapper,
  ) => PgRaw<PgQueryResultKind<NodePgQueryResultHKT, TRow>>;
};

type TenantWork<T> = (tx: TenantTransaction, tenantId: string | null) => Promise<T>;

export type TenantDatabase = {
  withTenant: <T>(context: TenantContext, fn: TenantWork<T>) => Promise<T>;
};

export type TenantPool = { pool: Pool; logger?: Logger };

const tenantLimits = {
  connectionTimeoutMillis: 5000,
  query_timeout: 7000,
  keepAlive: true,
};

export function tenantDatabase(url: string, options: { max?: number } = {}): TenantDatabase {
  const db = { pool: connect(url, { ...tenantLimits, max: options.max }) };
  let roleCheck: Promise<void> | undefined;
  return {
    withTenant: async (context, fn) => {
      roleCheck ??= refuseBypassingRole(db).catch((error: unknown) => {
        roleCheck = undefined;
        throw error;
      });
      await roleCheck;
      return withTenant(db, context, fn);
    },
  };
}

async function transaction<T>(
  { pool, logger }: TenantPool,
  setTransaction: SQL | null,
  work: (db: NodePgDatabase, isOpen: () => boolean) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const lost = Promise.withResolvers<never>();
  let open = true;
  const onError = (error: Error) => {
    logConnectionError();
    lost.reject(error);
  };
  client.on('error', onError);
  const run = async () => {
    await client.query('begin');
    const guarded = new Proxy(client, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (key !== 'query' || typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (!open) throw new Error('transaction is closed');
          return Reflect.apply(value, target, args);
        };
      },
    });
    const db = drizzle({ client: guarded, logger });
    if (setTransaction !== null) await db.execute(setTransaction);
    const result = await work(db, () => open).finally(() => {
      open = false;
    });
    await client.query('commit');
    return result;
  };
  let failed = true;
  try {
    const result = await Promise.race([run(), lost.promise]);
    failed = false;
    return result;
  } finally {
    open = false;
    client.off('error', onError);
    // destroyed instead of rolled back: a rollback on a half-open socket waits out query_timeout
    client.release(failed);
  }
}

async function refuseBypassingRole(db: TenantPool): Promise<void> {
  const bypass = await transaction(db, sql`set transaction read only`, async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', '5s', true)`);
    const {
      rows: [role],
    } = await tx.execute<{ bypass: boolean }>(
      sql`select rolsuper or rolbypassrls as bypass from pg_catalog.pg_roles where rolname = current_user`,
    );
    return role?.bypass;
  });
  if (bypass !== false) {
    throw new Error('withTenant refuses a database role with SUPERUSER or BYPASSRLS');
  }
}

function plain(tx: NodePgDatabase, isOpen: () => boolean): TenantTransaction {
  const open = () => {
    if (!isOpen()) throw new Error('transaction is closed');
  };
  function select(): PgSelectBuilder<undefined, 'db'>;
  function select<TSelection extends SelectedFields>(
    fields: TSelection,
  ): PgSelectBuilder<TSelection, 'db'>;
  function select(fields?: SelectedFields) {
    open();
    return fields === undefined ? tx.select() : tx.select(fields);
  }
  return {
    select,
    insert: (table) => {
      open();
      return tx.insert(table);
    },
    update: (table) => {
      open();
      return tx.update(table);
    },
    delete: (table) => {
      open();
      return tx.delete(table);
    },
    $count: (source, filters) => {
      open();
      return tx.$count(source, filters);
    },
    execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(
      query: SQLWrapper,
    ) => {
      open();
      const statement = query.getSQL?.();
      if (!is(statement, SQL)) throw new TypeError('execute takes drizzle SQL only');
      return tx.execute<TRow>(statement);
    },
  };
}

type Context = { tenantId: string | null };

function firstTenant(context: TenantContext) {
  if (context.kind === 'site') {
    return sql`coalesce(app.resolve_site(${context.site}::text)::text, '')`;
  }
  if (context.kind === 'user' && context.onboarding === true) return sql`gen_random_uuid()::text`;
  return sql`''`;
}

export async function withTenant<T>(
  db: TenantPool,
  input: TenantContext,
  fn: TenantWork<T>,
): Promise<T> {
  const parsed = v.safeParse(contextSchema, input);
  if (!parsed.success) throw new TypeError('withTenant takes exactly one context shape');
  const context = parsed.output;
  const userId = context.kind === 'user' ? context.userId : null;
  const tenant = firstTenant(context);
  const job = context.kind === 'job' ? sql`'domain-recheck'` : sql`''`;
  return transaction(
    db,
    context.kind === 'site' ? sql`set transaction isolation level repeatable read read only` : null,
    async (raw, isOpen) => {
      const tx = plain(raw, isOpen);
      const {
        rows: [set],
      } = await tx.execute<Context>(
        sql`select set_config('statement_timeout', '5s', true), set_config('lock_timeout', '2s', true), set_config('idle_in_transaction_session_timeout', '10s', true), set_config('app.job', ${job}, true), set_config('app.user_id', coalesce(${userId}::uuid::text, ''), true), nullif(set_config('app.tenant_id', ${tenant}, true), '') as "tenantId"`,
      );
      if (userId === null || set.tenantId !== null) return fn(tx, set.tenantId);
      const {
        rows: [owned],
      } = await tx.execute<Context>(
        sql`select nullif(set_config('app.tenant_id', coalesce((select id::text from public.tenants where owner_id = app.user_id()), ''), true), '') as "tenantId"`,
      );
      return fn(tx, owned.tenantId);
    },
  );
}
