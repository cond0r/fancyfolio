import { parseEnv } from '@fancyfolio/contracts';
import type postgres from 'postgres';
import * as v from 'valibot';
import { connect } from '../src/client.ts';

export async function withOwner(run: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const { OWNER_DATABASE_URL } = parseEnv(
    v.object({ OWNER_DATABASE_URL: v.pipe(v.string(), v.url()) }),
    process.env,
  );
  const sql = connect(OWNER_DATABASE_URL);
  try {
    await run(sql);
  } finally {
    await sql.end();
  }
}
