import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from '@fancyfolio/contracts';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import * as v from 'valibot';
import type { TestProject } from 'vitest/node';
import { roleEnv, setRolePasswords } from '../scripts/roles.ts';
import { connect, loopbackHosts, parseDatabaseUrl } from '../src/client.ts';
import { authTables } from './auth-tables.ts';
import { latestMigration } from './journal.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    db: {
      mode: 'local' | 'target';
      ownerUrl: string;
      appUrl: string;
      authUrl: string;
      writeRefusal: string | null;
    };
  }
}

const migrations = join(import.meta.dirname, '..', 'drizzle');
const targetEnv = v.object({
  TARGET_DATABASE_URL: v.pipe(v.string(), v.url()),
  TARGET_POOLER_URL: v.pipe(v.string(), v.url()),
  ...roleEnv.entries,
});

export function roleUrl(base: string, role: string, password: string, pooler = false): string {
  const url = new URL(base);
  const [, ...ref] = url.username.split('.');
  url.username = pooler ? [role, ...ref].join('.') : role;
  url.password = encodeURIComponent(password);
  return url.href;
}

async function writeRefusal(pool: Pool): Promise<string | null> {
  const owner = drizzle(pool);
  const {
    rows: [{ bypass }],
  } = await owner.execute<{ bypass: boolean }>(sql`
    select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user
  `);
  if (!bypass) {
    return 'the target owner role lacks BYPASSRLS, so forced RLS hides rows from it; run only the catalog suite';
  }
  const {
    rows: [{ migrated }],
  } = await owner.execute<{ migrated: boolean }>(sql`
    select to_regclass('drizzle.__drizzle_migrations') is not null as migrated
  `);
  const [{ latest }] = migrated
    ? (
        await owner.execute<{ latest: string | null }>(sql`
          select max(created_at)::text as latest from drizzle.__drizzle_migrations
        `)
      ).rows
    : [{ latest: null }];
  const journalHead = latestMigration(
    readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8'),
  );
  if (latest !== null && Number(latest) > Number(journalHead)) {
    return 'the target database holds migrations this checkout lacks; run the suites from the checkout that applied them';
  }
  if (latest !== journalHead) {
    return "the target database is not at this checkout's latest migration; migrate it first";
  }
  const held = sql.join(
    authTables.map((table) => sql`exists (select from public.${sql.identifier(table)})`),
    sql` or `,
  );
  const {
    rows: [row],
  } = await owner.execute<{ held: boolean }>(sql`select ${held} as held`);
  return row.held ? 'the target database holds auth rows; run only the catalog suite' : null;
}

async function useTarget(project: TestProject): Promise<undefined> {
  const env = parseEnv(targetEnv, process.env);
  const owner = connect(env.TARGET_DATABASE_URL);
  try {
    project.provide('db', {
      mode: 'target',
      ownerUrl: env.TARGET_DATABASE_URL,
      appUrl: roleUrl(env.TARGET_POOLER_URL, 'ff_app', env.FF_APP_PASSWORD, true),
      authUrl: roleUrl(env.TARGET_POOLER_URL, 'ff_auth', env.FF_AUTH_PASSWORD, true),
      writeRefusal: await writeRefusal(owner),
    });
  } finally {
    await owner.end();
  }
}

async function migrateTestDatabase(ownerUrl: string): Promise<void> {
  const owner = connect(ownerUrl);
  const db = drizzle(owner);
  try {
    await db.execute(sql`
      do $$
      declare
        role_name text;
      begin
        for role_name in
          select rolname from pg_catalog.pg_roles
          where rolname in ('anon', 'authenticated', 'service_role')
        loop
          execute format('alter default privileges in schema public grant all on tables to %I', role_name);
          execute format('alter default privileges in schema public grant all on functions to %I', role_name);
          execute format('alter default privileges in schema public grant all on sequences to %I', role_name);
        end loop;
      end
      $$
    `);
    await migrate(db, { migrationsFolder: migrations });
    await setRolePasswords(db, process.env);
  } finally {
    await owner.end();
  }
}

export default async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
  if (process.env.TARGET_DATABASE_URL !== undefined) return useTarget(project);
  const env = parseEnv(
    v.object({ TEST_DATABASE_URL: v.pipe(v.string(), v.url()), ...roleEnv.entries }),
    process.env,
  );
  const target = parseDatabaseUrl(env.TEST_DATABASE_URL);
  if (target.database !== 'fancyfolio_test') {
    throw new Error('TEST_DATABASE_URL must name the fancyfolio_test database');
  }
  if (!loopbackHosts.has(target.host)) {
    throw new Error('TEST_DATABASE_URL must point at a loopback host');
  }

  const maintenanceUrl = new URL(env.TEST_DATABASE_URL);
  maintenanceUrl.pathname = '/postgres';
  const maintenance = connect(maintenanceUrl.href);
  const session = await maintenance.connect();
  const close = async () => {
    session.release();
    await maintenance.end();
  };

  try {
    const {
      rows: [{ locked }],
    } = await session.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext('fancyfolio_test')) as locked",
    );
    if (!locked) throw new Error('Another database test run holds the fancyfolio_test lock');
    await session.query('drop database if exists fancyfolio_test with (force)');
    await session.query('create database fancyfolio_test');
    await migrateTestDatabase(env.TEST_DATABASE_URL);
  } catch (error) {
    await close();
    throw error;
  }

  project.provide('db', {
    mode: 'local',
    ownerUrl: env.TEST_DATABASE_URL,
    appUrl: roleUrl(env.TEST_DATABASE_URL, 'ff_app', env.FF_APP_PASSWORD),
    authUrl: roleUrl(env.TEST_DATABASE_URL, 'ff_auth', env.FF_AUTH_PASSWORD),
    writeRefusal: null,
  });
  return close;
}
