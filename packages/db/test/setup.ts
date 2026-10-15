import { join } from 'node:path';
import { parseEnv } from '@fancyfolio/contracts';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as v from 'valibot';
import type { TestProject } from 'vitest/node';
import { roleEnv, setRolePasswords } from '../scripts/roles.ts';
import { connect, loopbackHosts, parseDatabaseUrl } from '../src/client.ts';

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

export function roleUrl(base: string, role: string, password: string, pooler = false): string {
  const url = new URL(base);
  const [, ...ref] = url.username.split('.');
  url.username = pooler ? [role, ...ref].join('.') : role;
  url.password = encodeURIComponent(password);
  return url.href;
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

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
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
