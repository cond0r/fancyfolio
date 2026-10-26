import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { expect, inject } from 'vitest';
import { tenants } from '../src/schema/tenants.ts';
import { withTenant } from '../src/with-tenant.ts';

export function requireWritable(): void {
  const refusal = inject('db').writeRefusal;
  if (refusal !== null) throw new Error(`Refused: ${refusal}`);
}

export async function createUser(auth: Pool, name: string, email: string): Promise<string> {
  const {
    rows: [user],
  } = await drizzle(auth).execute<{ id: string }>(sql`
    insert into users (name, email) values (${name}, ${email}) returning id
  `);
  return user.id;
}

export function createTenant(app: Pool, userId: string, subdomain: string): Promise<string> {
  return withTenant(
    { pool: app },
    { kind: 'user', userId, onboarding: true },
    async (tx, tenantId) => {
      if (tenantId === null) throw new Error('onboarding set no tenant id');
      await tx.insert(tenants).values({ id: tenantId, subdomain, ownerId: userId });
      return tenantId;
    },
  );
}

export async function deleteUsers(auth: Pool, ids: string[]): Promise<void> {
  const created = ids.filter((id) => id !== '');
  if (created.length === 0) return;
  const deleted = await drizzle(auth).execute(sql`delete from users where id in ${created}`);
  expect(deleted.rowCount).toBe(created.length);
}
