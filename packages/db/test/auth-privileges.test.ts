import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';
import { authTables } from './auth-tables.ts';
import { requireWritable } from './fixtures.ts';

const { appUrl, authUrl } = inject('db');
const app = connect(appUrl);
const auth = connect(authUrl);

beforeAll(requireWritable);

afterAll(async () => {
  await Promise.all([app.end(), auth.end()]);
});

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

async function inRollback(pool: Pool, run: (tx: Transaction) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  await expect(
    drizzle(pool).transaction(async (tx) => {
      await run(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

describe.each(authTables)('ff_app on %s', (table) => {
  it('is refused SELECT, INSERT, UPDATE and DELETE', async () => {
    const denied = { cause: { code: '42501' } };
    const db = drizzle(app);
    const name = sql.identifier(table);
    await expect(db.execute(sql`select 1 from ${name}`)).rejects.toMatchObject(denied);
    await expect(db.execute(sql`insert into ${name} default values`)).rejects.toMatchObject(denied);
    await expect(db.execute(sql`update ${name} set id = id`)).rejects.toMatchObject(denied);
    await expect(db.execute(sql`delete from ${name}`)).rejects.toMatchObject(denied);
  });
});

describe('ff_auth', () => {
  it('selects, inserts, updates and deletes rows in every auth table', async () => {
    await inRollback(auth, async (tx) => {
      const {
        rows: [user],
      } = await tx.execute<{ id: string }>(sql`
        insert into users (name, email) values ('Ines Okafor', 'ines@example.test') returning id
      `);
      await tx.execute(sql`
        insert into sessions (expires_at, token, updated_at, user_id)
        values (now() + interval '1 day', 'session-token-fixture', now(), ${user.id})
      `);
      await tx.execute(sql`
        insert into accounts (account_id, provider_id, updated_at, user_id)
        values (${user.id}, 'credential', now(), ${user.id})
      `);
      await tx.execute(sql`
        insert into verifications (identifier, value, expires_at)
        values ('verification-fixture', 'value-fixture', now() + interval '1 hour')
      `);
      await tx.execute(sql`
        insert into apikeys (reference_id, key, created_at, updated_at)
        values (${user.id}, 'key-hash-fixture', now(), now())
      `);
      await tx.execute(
        sql`insert into rate_limits (key, count, last_request) values ('rate-fixture', 1, 0)`,
      );
      for (const table of authTables) {
        const name = sql.identifier(table);
        expect((await tx.execute(sql`select id from ${name}`)).rowCount, table).toBe(1);
        expect((await tx.execute(sql`update ${name} set id = id`)).rowCount, table).toBe(1);
      }
      for (const table of [...authTables.filter((table) => table !== 'users'), 'users']) {
        expect((await tx.execute(sql`delete from ${sql.identifier(table)}`)).rowCount, table).toBe(
          1,
        );
      }
    });
  });
});
