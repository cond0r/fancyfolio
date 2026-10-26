import { parseEnv } from '@fancyfolio/contracts';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as v from 'valibot';
import { connect } from '../src/client.ts';

export async function withOwner(run: (db: NodePgDatabase) => Promise<void>): Promise<void> {
  const { OWNER_DATABASE_URL } = parseEnv(
    v.object({ OWNER_DATABASE_URL: v.pipe(v.string(), v.url()) }),
    process.env,
  );
  const pool = connect(OWNER_DATABASE_URL);
  try {
    await run(drizzle(pool));
  } finally {
    await pool.end();
  }
}
