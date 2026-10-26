import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';

const { appUrl, authUrl } = inject('db');
const app = connect(appUrl);
const auth = connect(authUrl);

afterAll(() => Promise.all([app.end(), auth.end()]));

it('prepares no statements, so a transaction pooler can carry it', async () => {
  const session = await app.connect();
  try {
    const db = drizzle(session);
    await db.execute(sql`select 1 as one`);
    await db.execute(sql`select 1 as one`);
    const {
      rows: [{ prepared }],
    } = await db.execute<{ prepared: number }>(sql`
      select count(*)::int as prepared from pg_catalog.pg_prepared_statements
    `);
    expect(prepared).toBe(0);
  } finally {
    session.release();
  }
});

it('logs in as ff_app and ff_auth through the role URLs', async () => {
  const [asApp, asAuth] = await Promise.all(
    [app, auth].map(async (pool) => {
      const {
        rows: [row],
      } = await drizzle(pool).execute<{ name: string }>(sql`select current_user as name`);
      return row;
    }),
  );
  expect([asApp.name, asAuth.name]).toEqual(['ff_app', 'ff_auth']);
});
