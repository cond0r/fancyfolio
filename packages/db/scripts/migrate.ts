import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { withOwner } from './owner.ts';

await withOwner(async (sql) => {
  await migrate(drizzle(sql), { migrationsFolder: join(import.meta.dirname, '..', 'drizzle') });
  console.log('Migrations applied.');
});
