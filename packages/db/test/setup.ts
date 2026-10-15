import { join } from 'node:path';
import { parseEnv } from '@fancyfolio/contracts';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Sql } from 'postgres';
import * as v from 'valibot';
import type { TestProject } from 'vitest/node';
import { roleEnv, setRolePasswords } from '../scripts/roles.ts';
import { connect, loopbackHosts, parseDatabaseUrl } from '../src/client.ts';
import { authTables } from './auth-tables.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    db: {
      mode: 'local' | 'target';
      ownerUrl: string;
      appUrl: string;
      authUrl: string;
      writable: boolean;
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

async function holdsAuthRows(owner: Sql): Promise<boolean> {
  const held = authTables
    .map((table) => owner`exists (select from ${owner(table)})`)
    .reduce((either, next) => owner`${either} or ${next}`);
  const [row] = await owner<{ held: boolean }[]>`select ${held} as held`;
  return row.held;
}

async function useTarget(project: TestProject): Promise<undefined> {
  const env = parseEnv(targetEnv, process.env);
  const owner = connect(env.TARGET_DATABASE_URL);
  try {
    const [{ bypass }] = await owner<{ bypass: boolean }[]>`
      select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user
    `;
    const writable = bypass && !(await holdsAuthRows(owner));
    project.provide('db', {
      mode: 'target',
      ownerUrl: env.TARGET_DATABASE_URL,
      appUrl: roleUrl(env.TARGET_POOLER_URL, 'ff_app', env.FF_APP_PASSWORD, true),
      authUrl: roleUrl(env.TARGET_POOLER_URL, 'ff_auth', env.FF_AUTH_PASSWORD, true),
      writable,
    });
  } finally {
    await owner.end();
  }
}

async function migrateTestDatabase(ownerUrl: string): Promise<void> {
  const owner = connect(ownerUrl);
  try {
    await owner`
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
    `;
    await migrate(drizzle(owner), { migrationsFolder: migrations });
    await setRolePasswords(owner, process.env);
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
  const session = await maintenance.reserve();
  const close = async () => {
    session.release();
    await maintenance.end();
  };

  try {
    const [{ locked }] = await session<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtext('fancyfolio_test')) as locked
    `;
    if (!locked) throw new Error('Another database test run holds the fancyfolio_test lock');
    await session`drop database if exists fancyfolio_test with (force)`;
    await session`create database fancyfolio_test`;
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
    writable: true,
  });
  return close;
}
