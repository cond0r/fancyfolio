import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as auth from '../src/schema/auth.ts';

export const authTables = Object.values(auth)
  .filter((value) => is(value, PgTable))
  .map((table) => getTableName(table))
  .sort();
