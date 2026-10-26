import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { withOwner } from './owner.ts';

await withOwner(async (db) => {
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '..', 'drizzle') });
  console.log('Migrations applied.');
});
