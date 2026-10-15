import { afterAll, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';

const { appUrl, authUrl } = inject('db');
const app = connect(appUrl);
const auth = connect(authUrl);

afterAll(() => Promise.all([app.end(), auth.end()]));

it('prepares no statements, so a transaction pooler can carry it', async () => {
  const session = await app.reserve();
  try {
    await session`select 1 as one`;
    await session`select 1 as one`;
    const [{ prepared }] = await session<{ prepared: number }[]>`
      select count(*)::int as prepared from pg_catalog.pg_prepared_statements
    `;
    expect(prepared).toBe(0);
  } finally {
    session.release();
  }
});

it('logs in as ff_app and ff_auth through the role URLs', async () => {
  const [[asApp], [asAuth]] = await Promise.all([
    app<{ name: string }[]>`select current_user as name`,
    auth<{ name: string }[]>`select current_user as name`,
  ]);
  expect([asApp.name, asAuth.name]).toEqual(['ff_app', 'ff_auth']);
});
