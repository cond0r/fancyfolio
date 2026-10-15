import type { Sql, TransactionSql } from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';
import { authTables } from './auth-tables.ts';

const { appUrl, authUrl } = inject('db');
const app = connect(appUrl);
const auth = connect(authUrl);

afterAll(async () => {
  await Promise.all([app.end(), auth.end()]);
});

async function inRollback(sql: Sql, run: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  await expect(
    sql.begin(async (tx) => {
      await run(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

describe.each(authTables)('ff_app on %s', (table) => {
  it('is refused SELECT, INSERT, UPDATE and DELETE', async () => {
    const denied = { code: '42501' };
    await expect(app`select 1 from ${app(table)}`).rejects.toMatchObject(denied);
    await expect(app`insert into ${app(table)} default values`).rejects.toMatchObject(denied);
    await expect(app`update ${app(table)} set id = id`).rejects.toMatchObject(denied);
    await expect(app`delete from ${app(table)}`).rejects.toMatchObject(denied);
  });
});

describe('ff_auth', () => {
  it('selects, inserts, updates and deletes rows in every auth table', async () => {
    await inRollback(auth, async (tx) => {
      const [user] = await tx`
        insert into users (name, email) values ('Ines Okafor', 'ines@example.test') returning id
      `;
      await tx`
        insert into sessions (expires_at, token, updated_at, user_id)
        values (now() + interval '1 day', 'session-token-fixture', now(), ${user.id})
      `;
      await tx`
        insert into accounts (account_id, provider_id, updated_at, user_id)
        values (${user.id}, 'credential', now(), ${user.id})
      `;
      await tx`
        insert into verifications (identifier, value, expires_at)
        values ('verification-fixture', 'value-fixture', now() + interval '1 hour')
      `;
      await tx`
        insert into apikeys (reference_id, key, created_at, updated_at)
        values (${user.id}, 'key-hash-fixture', now(), now())
      `;
      await tx`insert into rate_limits (key, count, last_request) values ('rate-fixture', 1, 0)`;
      for (const table of authTables) {
        expect((await tx`select id from ${tx(table)}`).count, table).toBe(1);
        expect((await tx`update ${tx(table)} set id = id`).count, table).toBe(1);
      }
      for (const table of [...authTables.filter((table) => table !== 'users'), 'users']) {
        expect((await tx`delete from ${tx(table)}`).count, table).toBe(1);
      }
    });
  });
});
