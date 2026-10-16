import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';
import { tenants } from '../src/schema/tenants.ts';
import { withTenant } from '../src/with-tenant.ts';
import { createUser, deleteUsers, requireWritable } from './fixtures.ts';

const { appUrl, authUrl } = inject('db');
const app = connect(appUrl);
const auth = connect(authUrl);
const db = drizzle(app);
const migrations = join(import.meta.dirname, '..', 'drizzle');
const rollback = new Error('rollback');
let userId = '';

beforeAll(async () => {
  requireWritable();
  userId = await createUser(auth, 'Priya Raman', 'priya@example.test');
});

afterAll(async () => {
  await deleteUsers(auth, [userId]);
  await Promise.all([app.end(), auth.end()]);
});

async function databaseAccepts(subdomain: string): Promise<boolean> {
  const outcome = await withTenant(db, { userId, onboarding: true }, async (tx, id) => {
    await tx.insert(tenants).values({ id: id ?? '', subdomain, ownerId: userId });
    throw rollback;
  }).catch((error: unknown) => error);
  if (outcome === rollback) return true;
  expect(outcome).toMatchObject({
    cause: { code: '23514', constraint_name: 'tenants_subdomain_check' },
  });
  return false;
}

describe('the subdomain rule', () => {
  it('lets the database refuse reserved and malformed subdomains and keep hostile text inert', async () => {
    for (const value of ['admin', 'www', 'demo', 'xn--ines', 'Ines', 'ab', 'a'.repeat(33)]) {
      expect(await databaseAccepts(value), value).toBe(false);
    }
    expect(await databaseAccepts("a'); drop table tenants; --")).toBe(false);
    expect(await withTenant(db, { userId }, (tx) => tx.select().from(tenants))).toEqual([]);
    expect(await databaseAccepts('ines')).toBe(true);
  });

  it('holds in the latest migration that adds the CHECK exactly the text the schema generates', () => {
    const [constraint] = getTableConfig(tenants).checks;
    const text = new PgDialect().sqlToQuery(constraint.value).sql;
    const statement = `ALTER TABLE "tenants" ADD CONSTRAINT "${constraint.name}" CHECK (${text});`;
    const added = readdirSync(migrations)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .flatMap((file) =>
        readFileSync(join(migrations, file), 'utf8').split('--> statement-breakpoint'),
      )
      .map((part) => part.trim())
      .filter((part) => part.includes(`ADD CONSTRAINT "${constraint.name}"`));
    expect(added.at(-1)).toBe(statement);
  });
});
