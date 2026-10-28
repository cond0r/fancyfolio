import { type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { expect, inject } from 'vitest';
import { tenants } from '../src/schema/tenants.ts';
import { type TenantPool, type TenantTransaction, withTenant } from '../src/with-tenant.ts';

export function requireWritable(): void {
  const refusal = inject('db').writeRefusal;
  if (refusal !== null) throw new Error(`Refused: ${refusal}`);
}

export function rows<T extends Record<string, unknown> = Record<string, unknown>>(
  on: Pick<TenantTransaction, 'execute'>,
) {
  return async (query: SQL) => (await on.execute<T>(query)).rows;
}

export async function outcomeOf(run: () => unknown): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error;
  }
}

export async function createUser(auth: Pool, name: string, email: string): Promise<string> {
  const [user] = await rows<{ id: string }>(drizzle(auth))(sql`
    insert into users (name, email) values (${name}, ${email}) returning id
  `);
  return user.id;
}

export function createTenant(db: TenantPool, userId: string, subdomain: string): Promise<string> {
  return withTenant(db, { kind: 'user', userId, onboarding: true }, async (tx, tenantId) => {
    if (tenantId === null) throw new Error('onboarding set no tenant id');
    await tx.insert(tenants).values({ id: tenantId, subdomain, ownerId: userId });
    return tenantId;
  });
}

export async function deleteUsers(auth: Pool, ids: string[]): Promise<void> {
  const created = ids.filter((id) => id !== '');
  if (created.length === 0) return;
  const deleted = await drizzle(auth).execute(sql`delete from users where id in ${created}`);
  expect(deleted.rowCount).toBe(created.length);
}
