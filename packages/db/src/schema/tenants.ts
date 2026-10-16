import { RESERVED_SUBDOMAINS, SUBDOMAIN_PATTERN } from '@fancyfolio/contracts';
import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.ts';

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    subdomain: text('subdomain').notNull().unique(),
    ownerId: uuid('owner_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'tenants_subdomain_check',
      sql`${table.subdomain} ~ ${SUBDOMAIN_PATTERN} and ${table.subdomain} not in ${RESERVED_SUBDOMAINS}`.inlineParams(),
    ),
  ],
);
