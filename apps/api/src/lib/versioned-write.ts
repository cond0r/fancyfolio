import type { TenantTransaction } from '@fancyfolio/db';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Context } from 'hono';
import { db } from '../db.ts';
import type { SessionEnv } from '../middleware/session.ts';
import { errorCode } from '../shell.ts';

type Versioned = PgTable & { updatedAt: PgColumn };
type Item = Versioned & { id: PgColumn; tenantId: PgColumn };

export function asOwner<T>(
  c: Context<SessionEnv>,
  fn: (tx: TenantTransaction, tenantId: string) => Promise<T>,
): Promise<T | null> {
  return db.withTenant({ kind: 'user', userId: c.get('user').id }, async (tx, tenantId) =>
    tenantId === null ? null : fn(tx, tenantId),
  );
}

export function busyOnLockTimeout(error: unknown): 'busy' {
  if (errorCode(error) === '55P03') return 'busy';
  throw error;
}

export function ownedItem(table: Item, tenantId: string, id: string): SQL {
  return sql`${eq(table.tenantId, tenantId)} and ${eq(table.id, id)}`;
}

export async function insertCapped<Row>(
  tx: TenantTransaction,
  table: Item,
  cap: number,
  { id, tenantId }: { id: string; tenantId: string },
  read: (where: SQL) => Promise<Row[]>,
  insert: () => Promise<Row[]>,
): Promise<Row | 'full' | 'taken'> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
  const [replay] = await read(ownedItem(table, tenantId, id));
  if (replay !== undefined) return replay;
  if ((await tx.$count(table, eq(table.tenantId, tenantId))) >= cap) return 'full';
  const [row] = await insert();
  return row ?? 'taken';
}

export async function updateVersioned<Row>(
  tx: TenantTransaction,
  table: Versioned,
  key: SQL,
  updatedAt: string,
  update: (where: SQL | undefined) => Promise<Row[]>,
): Promise<Row | 404 | 409> {
  const [row] = await update(and(key, eq(table.updatedAt, updatedAt)));
  if (row !== undefined) return row;
  return (await tx.$count(table, key)) === 0 ? 404 : 409;
}

export function deleteVersioned(
  tx: TenantTransaction,
  table: Versioned,
  key: SQL,
  updatedAt: string,
) {
  return updateVersioned(tx, table, key, updatedAt, (where) =>
    tx.delete(table).where(where).returning({ updatedAt: table.updatedAt }),
  );
}
