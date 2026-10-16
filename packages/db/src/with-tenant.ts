import { is, SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { PgQueryResultKind } from 'drizzle-orm/pg-core';
import type { PgRaw } from 'drizzle-orm/pg-core/query-builders/raw';
import {
  drizzle,
  type PostgresJsDatabase,
  type PostgresJsQueryResultHKT,
} from 'drizzle-orm/postgres-js';
import * as v from 'valibot';
import { connect } from './client.ts';

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

type DrizzleTransaction = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

export type TenantTransaction = Pick<
  DrizzleTransaction,
  'select' | 'insert' | 'update' | 'delete' | '$count'
> & {
  execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    query: SQLWrapper,
  ) => PgRaw<PgQueryResultKind<PostgresJsQueryResultHKT, TRow>>;
};

type TenantWork<T> = (tx: TenantTransaction, tenantId: string | null) => Promise<T>;

export type TenantDatabase = {
  withTenant: <T>(context: TenantContext, fn: TenantWork<T>) => Promise<T>;
};

export function tenantDatabase(url: string): TenantDatabase {
  const db = drizzle(connect(url));
  return { withTenant: (context, fn) => withTenant(db, context, fn) };
}

function plain(tx: DrizzleTransaction): TenantTransaction {
  return {
    select: tx.select.bind(tx),
    insert: tx.insert.bind(tx),
    update: tx.update.bind(tx),
    delete: tx.delete.bind(tx),
    $count: tx.$count.bind(tx),
    execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(
      query: SQLWrapper,
    ) => {
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
  db: PostgresJsDatabase,
  input: TenantContext,
  fn: TenantWork<T>,
): Promise<T> {
  const parsed = v.safeParse(contextSchema, input);
  if (!parsed.success) throw new TypeError('withTenant takes exactly one context shape');
  const context = parsed.output;
  const userId = context.kind === 'user' ? context.userId : null;
  const tenant = firstTenant(context);
  const job = context.kind === 'job' ? sql`'domain-recheck'` : sql`''`;
  return db.transaction(
    async (raw) => {
      const tx = plain(raw);
      const [set] = await tx.execute<Context>(
        sql`select set_config('statement_timeout', '5s', true), set_config('lock_timeout', '2s', true), set_config('idle_in_transaction_session_timeout', '10s', true), set_config('app.job', ${job}, true), set_config('app.user_id', coalesce(${userId}::uuid::text, ''), true), nullif(set_config('app.tenant_id', ${tenant}, true), '') as "tenantId"`,
      );
      if (userId === null || set.tenantId !== null) return fn(tx, set.tenantId);
      const [owned] = await tx.execute<Context>(
        sql`select nullif(set_config('app.tenant_id', coalesce((select id::text from public.tenants where owner_id = app.user_id()), ''), true), '') as "tenantId"`,
      );
      return fn(tx, owned.tenantId);
    },
    context.kind === 'site' ? { accessMode: 'read only' } : undefined,
  );
}
