import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { expect, inject } from 'vitest';
import { tenants } from '../src/schema/tenants.ts';
import { withTenant } from '../src/with-tenant.ts';

export function requireWritable(): void {
  const refusal = inject('db').writeRefusal;
  if (refusal !== null) throw new Error(`Refused: ${refusal}`);
}

export async function createUser(auth: Sql, name: string, email: string): Promise<string> {
  const [user] = await auth<{ id: string }[]>`
    insert into users (name, email) values (${name}, ${email}) returning id
  `;
  return user.id;
}

export function createTenant(
  db: PostgresJsDatabase,
  userId: string,
  subdomain: string,
): Promise<string> {
  return withTenant(db, { kind: 'user', userId, onboarding: true }, async (tx, tenantId) => {
    if (tenantId === null) throw new Error('onboarding set no tenant id');
    await tx.insert(tenants).values({ id: tenantId, subdomain, ownerId: userId });
    return tenantId;
  });
}

export async function deleteUsers(auth: Sql, ids: string[]): Promise<void> {
  const created = ids.filter((id) => id !== '');
  if (created.length === 0) return;
  const deleted = await auth`delete from users where id in ${auth(created)}`;
  expect(deleted.count).toBe(created.length);
}
