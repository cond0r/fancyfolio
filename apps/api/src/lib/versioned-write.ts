import type { TenantTransaction } from '@fancyfolio/db';
import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Context } from 'hono';
import { db } from '../db.ts';
import type { SessionEnv } from '../middleware/session.ts';

type Versioned = PgTable & { updatedAt: PgColumn };

export function asOwner<T>(
  c: Context<SessionEnv>,
  fn: (tx: TenantTransaction, tenantId: string) => Promise<T>,
): Promise<T | null> {
  return db.withTenant({ kind: 'user', userId: c.get('user').id }, async (tx, tenantId) =>
    tenantId === null ? null : fn(tx, tenantId),
  );
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
