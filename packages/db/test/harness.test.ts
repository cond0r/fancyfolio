import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { setRolePasswords } from '../scripts/roles.ts';
import { connect, connectionOptions } from '../src/client.ts';
import { latestMigration } from './journal.ts';
import { roleUrl } from './setup.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const rolesMigration = join(import.meta.dirname, '..', 'drizzle', '0000_roles.sql');
const tenantsRlsMigration = join(import.meta.dirname, '..', 'drizzle', '0004_tenants-rls.sql');
const inheritedDbEnv =
  /^(VITEST|TARGET_|FF_)|^(TEST_DATABASE_URL|OWNER_DATABASE_URL|DATABASE_CA_CERT)$/;
const U = 'postgres://fancyfolio_owner:unused@127.0.0.1:1/fancyfolio_test';
const P = { FF_APP_PASSWORD: 'a'.repeat(32), FF_AUTH_PASSWORD: 'b'.repeat(32) };

function run(command: string, args: string[], env: Record<string, string | undefined>, cwd = root) {
  const clean = Object.entries(process.env).filter(
    ([name]) => !inheritedDbEnv.test(name) && name !== 'FORCE_COLOR',
  );
  const child = spawnSync(command, args, {
    cwd,
    env: { ...Object.fromEntries(clean), NO_COLOR: '1', ...env },
    encoding: 'utf8',
    timeout: 25_000,
  });
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

function runNode(args: string[], env: Record<string, string | undefined>) {
  return run(process.execPath, args, env);
}

function runDbSuites(env: Record<string, string | undefined>, ...files: string[]) {
  return runNode(['node_modules/vitest/vitest.mjs', 'run', '--project', 'db', ...files], env);
}

it('puts the role and the encoded password into the URL, the user suffix kept only for the pooler', () => {
  expect(
    roleUrl(
      'postgres://postgres.abcdef:owner@pooler.example.test:6543/postgres',
      'ff_app',
      'p@ss/w:rd',
      true,
    ),
  ).toBe('postgres://ff_app.abcdef:p%40ss%2Fw%3Ard@pooler.example.test:6543/postgres');
  expect(roleUrl('postgres://first.last:pw@127.0.0.1:5432/fancyfolio_test', 'ff_auth', 'x')).toBe(
    'postgres://ff_auth:x@127.0.0.1:5432/fancyfolio_test',
  );
  expect(decodeURIComponent(new URL(roleUrl(U, 'ff_app', 'abc%41%zz')).password)).toBe('abc%41%zz');
});

const journal = (...entries: [number, number][]) =>
  JSON.stringify({ entries: entries.map(([idx, when]) => ({ idx, when })) });

it('takes the last journal entry as the head and refuses a journal without entries', () => {
  expect(latestMigration(journal([0, 1700000000000], [1, 1700000000001]))).toBe('1700000000001');
  expect(() => latestMigration('{"entries":[]}')).toThrow(
    'the migration journal has no entries; generate a migration first',
  );
});

it.each([
  ['an entry older than the one before', journal([0, 1700000000002], [1, 1700000000001])],
  ['two entries at the same time', journal([0, 1700000000001], [1, 1700000000001])],
  ['entries out of index order', journal([1, 1700000000001], [0, 1700000000002])],
  ['a gap in the index', journal([0, 1700000000001], [2, 1700000000002])],
])('refuses a journal with %s, whose entry the migrator would skip', (_case, text) => {
  expect(() => latestMigration(text)).toThrow(
    'the migration journal is out of order: each entry needs the next index and a later time',
  );
});

it('holds the checked-in journal in order', () => {
  const text = readFileSync(
    join(import.meta.dirname, '..', 'drizzle', 'meta', '_journal.json'),
    'utf8',
  );
  expect(latestMigration(text)).toBe(String(JSON.parse(text).entries.at(-1).when));
});

it.each(['db:roles', 'db:migrate'])('%s refuses to run without an owner URL', (script) => {
  const child = run('pnpm', ['--silent', script], {});
  expect(child.status).toBe(1);
  expect(child.output).toContain('Invalid environment: OWNER_DATABASE_URL (missing)');
});

it('drizzle-kit has no credentials, so push cannot reach a database', () => {
  const child = run(
    join(root, 'packages', 'db', 'node_modules', '.bin', 'drizzle-kit'),
    ['push', '--force'],
    { OWNER_DATABASE_URL: U },
    join(root, 'packages', 'db'),
  );
  expect(child.status).toBe(1);
  expect(child.output).toContain('Either connection "url" or "host", "database" are required');
  expect(child.output).not.toContain('ECONNREFUSED');
});

describe.runIf(inject('db').mode === 'local')('the local harness', () => {
  it('fails instead of skipping when Postgres is unreachable', () => {
    const run = runDbSuites({ TEST_DATABASE_URL: U, ...P }, 'catalog');
    expect(run.status).toBe(1);
    expect(run.output).toContain('ECONNREFUSED');
    expect(run.output).not.toContain('skipped');
  });

  it('names every missing variable', () => {
    const run = runDbSuites({}, 'catalog');
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      'Invalid environment: TEST_DATABASE_URL (missing), FF_APP_PASSWORD (missing), FF_AUTH_PASSWORD (missing)',
    );
  });

  it('refuses any database but fancyfolio_test before connecting', () => {
    const run = runDbSuites(
      { TEST_DATABASE_URL: 'postgres://fancyfolio_owner:unused@127.0.0.1:1/fancyfolio_dev', ...P },
      'catalog',
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain('TEST_DATABASE_URL must name the fancyfolio_test database');
    expect(run.output).not.toContain('ECONNREFUSED');
  });

  it('refuses a host that is not loopback before connecting', () => {
    const run = runDbSuites(
      {
        TEST_DATABASE_URL: 'postgres://fancyfolio_owner:unused@db.example.test:1/fancyfolio_test',
        ...P,
      },
      'catalog',
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain('TEST_DATABASE_URL must point at a loopback host');
    expect(run.output).not.toContain('ENOTFOUND');
  });

  it('refuses connection parameters in the query before connecting', () => {
    const run = runDbSuites({ TEST_DATABASE_URL: `${U}?database=fancyfolio_dev`, ...P }, 'catalog');
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      'Database URL must be postgres://user:password@host[:port]/database',
    );
    expect(run.output).not.toContain('ECONNREFUSED');
  });

  it('refuses a second run while this one holds the lock', () => {
    const run = runDbSuites(
      {
        TEST_DATABASE_URL: inject('db').ownerUrl,
        FF_APP_PASSWORD: process.env.FF_APP_PASSWORD,
        FF_AUTH_PASSWORD: process.env.FF_AUTH_PASSWORD,
      },
      'catalog',
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain('Another database test run holds the fancyfolio_test lock');
    expect(run.output).not.toContain('close timed out');
  });
});

describe.runIf(inject('db').mode === 'local')('the roles migration', () => {
  it('runs again on existing roles, resets attributes changed by hand and keeps logins', async () => {
    const owner = connect(inject('db').ownerUrl);
    try {
      await owner`alter role ff_app bypassrls createdb createrole`;
      await owner`alter role ff_resolver login bypassrls createdb createrole`;
      await owner.file(rolesMigration);
      const roles = await owner`
        select rolname, rolcanlogin, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles
        where rolname in ('ff_app', 'ff_auth', 'ff_resolver') order by rolname
      `;
      expect(roles).toEqual(
        ['ff_app', 'ff_auth', 'ff_resolver'].map((rolname) => ({
          rolname,
          rolcanlogin: rolname !== 'ff_resolver',
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
        })),
      );
    } finally {
      await owner`alter role ff_app nobypassrls nocreatedb nocreaterole`;
      await owner`alter role ff_resolver nologin nobypassrls nocreatedb nocreaterole`;
      await owner.end();
    }
  });
});

describe.runIf(inject('db').mode === 'local')('the tenants RLS migration', () => {
  it.each([
    ['public', 'public, ff_app, ff_auth, ff_resolver'],
    ['ff_app', 'ff_app'],
  ])('fails when %s still holds TEMPORARY after its revoke', async (grantee, holders) => {
    const check = readFileSync(tenantsRlsMigration, 'utf8')
      .split('--> statement-breakpoint')
      .at(-1);
    const rollback = new Error('rolled back');
    const owner = connect(inject('db').ownerUrl);
    try {
      const error = await owner
        .begin(async (tx) => {
          const role = grantee === 'public' ? tx`public` : tx(grantee);
          await tx`grant temporary on database fancyfolio_test to ${role}`;
          await tx.unsafe(check ?? '');
          throw rollback;
        })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'P0001',
        message: `TEMPORARY on database fancyfolio_test is still held by ${holders}`,
      });
    } finally {
      await owner.end();
    }
  });
});

describe.runIf(inject('db').mode === 'local')('db:roles', () => {
  it('needs no TEMPORARY on the database and leaves no helper function behind', async () => {
    const owner = postgres({ ...connectionOptions(inject('db').ownerUrl, process.env), max: 1 });
    try {
      await owner`revoke temporary on database fancyfolio_test from current_user`;
      await setRolePasswords(owner, process.env);
      const [{ helpers }] = await owner<{ helpers: number }[]>`
        select count(*)::int as helpers from pg_proc
        where proname = 'set_login_password' or pronamespace = pg_my_temp_schema()
      `;
      expect(helpers).toBe(0);
    } finally {
      await owner`grant temporary on database fancyfolio_test to current_user`;
      await owner.end();
    }
  });

  it('resolves format() in its helper from pg_catalog whatever the session search_path', async () => {
    const owner = postgres({ ...connectionOptions(inject('db').ownerUrl, process.env), max: 1 });
    try {
      await owner`create schema shadow`;
      await owner`
        create function shadow.format(text, text, text) returns text language plpgsql
        as $$ begin raise exception 'shadowed format'; end $$
      `;
      await owner`set search_path = shadow, pg_catalog`;
      await expect(setRolePasswords(owner, process.env)).resolves.toBeUndefined();
    } finally {
      await owner`reset search_path`;
      await owner`drop schema shadow cascade`;
      await owner.end();
    }
  });

  it('turns login on for runtime roles left NOLOGIN, as a fresh migration creates them', async () => {
    const owner = connect(inject('db').ownerUrl);
    try {
      await owner`alter role ff_app nologin`;
      await owner`alter role ff_auth nologin`;
      await setRolePasswords(owner, process.env);
      const roles = await owner`
        select rolname, rolcanlogin from pg_roles
        where rolname in ('ff_app', 'ff_auth') order by rolname
      `;
      expect(roles).toEqual([
        { rolname: 'ff_app', rolcanlogin: true },
        { rolname: 'ff_auth', rolcanlogin: true },
      ]);
    } finally {
      await owner`alter role ff_app login`;
      await owner`alter role ff_auth login`;
      await owner.end();
    }
  });

  it('names the role and hides the verifier when ALTER ROLE is refused', async () => {
    const owner = connect(inject('db').ownerUrl);
    const app = connect(inject('db').appUrl);
    try {
      await owner`grant create on schema app to ff_app`;
      const error = await setRolePasswords(app, process.env).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        message: 'Could not set the login password for ff_app (SQLSTATE 42501)',
      });
      expect(inspect(error, { depth: 10, showHidden: true })).not.toContain('SCRAM-SHA-256');
    } finally {
      await owner`revoke create on schema app from ff_app`;
      await Promise.all([app.end(), owner.end()]);
    }
  });
});

describe.runIf(inject('db').mode === 'local')('the target mode', () => {
  const { ownerUrl } = inject('db');
  const owner = connect(ownerUrl);
  const target = {
    TARGET_DATABASE_URL: ownerUrl,
    TARGET_POOLER_URL: ownerUrl,
    FF_APP_PASSWORD: process.env.FF_APP_PASSWORD ?? '',
    FF_AUTH_PASSWORD: process.env.FF_AUTH_PASSWORD ?? '',
  };

  const writeSuites = ['auth-privileges', 'isolation', 'with-tenant', 'parity'];

  afterAll(() => owner.end());

  async function state() {
    const [row] = await owner`
      select
        (select oid::int from pg_database where datname = current_database()) as database,
        (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
        (select count(*)::int from public.users) as users,
        (select count(*)::int from public.tenants) as tenants
    `;
    return row;
  }

  it('leaves a pending migration pending and the role passwords unchanged', async () => {
    const scratch = new URL(ownerUrl);
    scratch.pathname = '/fancyfolio_test_target';
    await owner`drop database if exists fancyfolio_test_target with (force)`;
    await owner`create database fancyfolio_test_target`;
    const pending = connect(scratch.href);
    const asApp = connect(roleUrl(ownerUrl, 'ff_app', target.FF_APP_PASSWORD));
    try {
      const migrated = run('pnpm', ['--silent', 'db:migrate'], {
        OWNER_DATABASE_URL: scratch.href,
      });
      expect(migrated.status, migrated.output).toBe(0);
      await pending`
        update drizzle.__drizzle_migrations set created_at = created_at - 1
        where id = (select max(id) from drizzle.__drizzle_migrations)
      `;
      const journal = () =>
        pending`select id, hash, created_at::text from drizzle.__drizzle_migrations order by id`;
      const before = await journal();
      const targeted = runDbSuites(
        {
          TARGET_DATABASE_URL: scratch.href,
          TARGET_POOLER_URL: scratch.href,
          FF_APP_PASSWORD: 'c'.repeat(32),
          FF_AUTH_PASSWORD: 'd'.repeat(32),
        },
        'roles',
      );
      expect(targeted.output).toContain('Test Files  1 passed (1)');
      expect(targeted.status).toBe(0);
      expect(await journal()).toEqual(before);
      const [{ name }] = await asApp<{ name: string }[]>`select current_user as name`;
      expect(name).toBe('ff_app');
    } finally {
      await Promise.all([pending.end(), asApp.end()]);
      await owner`drop database if exists fancyfolio_test_target with (force)`;
    }
  });

  it('creates and migrates nothing and leaves no row behind on an empty database', async () => {
    const before = await state();
    const run = runDbSuites(target, ...writeSuites, 'catalog', 'client');
    expect(run.output).toContain('Test Files  6 passed (6)');
    expect(run.status).toBe(0);
    expect(await state()).toEqual({ ...before, users: 0, tenants: 0 });
  });

  function expectWritesRefused(reason: string, env = target) {
    const run = runDbSuites(env, ...writeSuites, 'catalog');
    expect(run.output).toContain('Test Files  4 failed | 1 passed (5)');
    expect(run.status).toBe(1);
    expect(run.output).toContain(`Refused: ${reason}; run only the catalog suite`);
  }

  const heldRows = 'the target database holds auth rows';

  it.each([
    {
      table: 'users',
      insert: () =>
        owner`insert into users (name, email) values ('Tomas Lindqvist', 'tomas@example.test')`,
      remove: () => owner`delete from users where email = 'tomas@example.test'`,
    },
    {
      table: 'rate_limits',
      insert: () =>
        owner`insert into rate_limits (key, count, last_request) values ('rate-probe', 1, 0)`,
      remove: () => owner`delete from rate_limits where key = 'rate-probe'`,
    },
  ])(
    'refuses the write suites while the database holds a $table row',
    async ({ insert, remove }) => {
      try {
        await insert();
        expectWritesRefused(heldRows);
      } finally {
        await remove();
      }
    },
  );

  it("counts the auth rows in public even when the owner's own schema shadows a table", async () => {
    const [{ name }] = await owner<{ name: string }[]>`select current_user as name`;
    try {
      await owner`create schema ${owner(name)}`;
      await owner`create table ${owner(`${name}.users`)} (id int)`;
      await owner`
        insert into public.users (name, email) values ('Tomas Lindqvist', 'tomas@example.test')
      `;
      expectWritesRefused(heldRows);
    } finally {
      await owner`drop schema if exists ${owner(name)} cascade`;
      await owner`delete from public.users where email = 'tomas@example.test'`;
    }
  });

  it('ignores a table the write suites never touch, even one the owner cannot read', async () => {
    try {
      await owner`create table provider_probe (id int)`;
      await owner`insert into provider_probe values (1)`;
      await owner`grant select on provider_probe to ff_auth`;
      await owner`revoke all on provider_probe from current_user`;
      const run = runDbSuites(target, 'auth-privileges');
      expect(run.output).toContain('Test Files  1 passed (1)');
      expect(run.status).toBe(0);
    } finally {
      await owner`drop table if exists provider_probe`;
    }
  });

  it('refuses the write suites when forced RLS hides the rows from an owner without BYPASSRLS', async () => {
    const probePassword = 'probe-owner-password-not-secret-01';
    try {
      await owner`drop role if exists ff_probe_owner`;
      await owner.begin(async (tx) => {
        await tx`
          create function pg_temp.create_probe_owner(secret text) returns void
          language plpgsql as $$
          begin
            execute format('create role ff_probe_owner login nobypassrls password %L', secret);
          end
          $$
        `;
        await tx`select pg_temp.create_probe_owner(${probePassword})`;
      });
      expectWritesRefused(
        'the target owner role lacks BYPASSRLS, so forced RLS hides rows from it',
        {
          ...target,
          TARGET_DATABASE_URL: roleUrl(ownerUrl, 'ff_probe_owner', probePassword),
        },
      );
    } finally {
      await owner`drop role if exists ff_probe_owner`;
    }
  });

  const behindRefusal =
    "Refused: the target database is not at this checkout's latest migration; migrate it first";
  const aheadRefusal =
    'Refused: the target database holds migrations this checkout lacks; run the suites from the checkout that applied them';

  it.each([
    ['an unmigrated database', behindRefusal, async () => {}],
    [
      'a database behind the journal',
      behindRefusal,
      async (url: string) => {
        const migrated = run('pnpm', ['--silent', 'db:migrate'], { OWNER_DATABASE_URL: url });
        expect(migrated.status, migrated.output).toBe(0);
        const behind = connect(url);
        try {
          await behind`drop table public.tenants cascade`;
          await behind`delete from drizzle.__drizzle_migrations where id > 3`;
        } finally {
          await behind.end();
        }
      },
    ],
    [
      'a database ahead of the journal',
      aheadRefusal,
      async (url: string) => {
        const migrated = run('pnpm', ['--silent', 'db:migrate'], { OWNER_DATABASE_URL: url });
        expect(migrated.status, migrated.output).toBe(0);
        const later = connect(url);
        try {
          await later`
            insert into drizzle.__drizzle_migrations (hash, created_at)
            select 'later', max(created_at) + 1 from drizzle.__drizzle_migrations
          `;
        } finally {
          await later.end();
        }
      },
    ],
  ])('refuses the write suites on %s, naming why', async (_case, refusal, prepare) => {
    const scratch = new URL(ownerUrl);
    scratch.pathname = '/fancyfolio_test_target';
    await owner`drop database if exists fancyfolio_test_target with (force)`;
    await owner`create database fancyfolio_test_target`;
    try {
      await prepare(scratch.href);
      const run = runDbSuites(
        { ...target, TARGET_DATABASE_URL: scratch.href, TARGET_POOLER_URL: scratch.href },
        ...writeSuites,
      );
      expect(run.output).toContain('Test Files  4 failed (4)');
      expect(run.status).toBe(1);
      expect(run.output).toContain(refusal);
      expect(run.output).not.toContain('42P01');
    } finally {
      await owner`drop database if exists fancyfolio_test_target with (force)`;
    }
  });

  it('connects the runtime roles through the pooler URL with its user suffix', () => {
    const pooler = new URL(ownerUrl);
    pooler.username = `${pooler.username}.abcdef`;
    const run = runDbSuites({ ...target, TARGET_POOLER_URL: pooler.href }, 'client');
    expect(run.status).toBe(1);
    expect(run.output).toContain('ff_app.abcdef');
    expect(run.output).toContain('Tests  2 failed (2)');
  });
});
