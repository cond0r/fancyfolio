import { afterAll, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';

const sql = connect(inject('db').appUrl);
const runtimeRoles = ['ff_app', 'ff_auth', 'ff_resolver'];

afterAll(() => sql.end());

it('runs on Postgres 17', async () => {
  const [{ major }] = await sql<{ major: number }[]>`
    select current_setting('server_version_num')::int / 10000 as major
  `;
  expect(major).toBe(17);
});

it('gives the runtime roles neither superuser nor bypassrls, and login to ff_app and ff_auth only', async () => {
  const roles = await sql`
    select rolname, rolsuper, rolbypassrls, rolcanlogin
    from pg_catalog.pg_roles
    where rolname in ${sql(runtimeRoles)}
    order by rolname
  `;
  expect([...roles]).toEqual([
    { rolname: 'ff_app', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
    { rolname: 'ff_auth', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
    { rolname: 'ff_resolver', rolsuper: false, rolbypassrls: false, rolcanlogin: false },
  ]);
});

it('has the app schema owned by a role without superuser that bypasses RLS', async () => {
  const owners = await sql`
    select r.rolsuper, r.rolbypassrls
    from pg_catalog.pg_namespace n
    join pg_catalog.pg_roles r on r.oid = n.nspowner
    where n.nspname = 'app'
  `;
  expect([...owners]).toEqual([{ rolsuper: false, rolbypassrls: true }]);
});

it('lets the runtime roles own nothing and belong to no role', async () => {
  const [counts] = await sql`
    select
      (select count(*)::int
       from pg_catalog.pg_shdepend d
       join pg_catalog.pg_roles r on r.oid = d.refobjid
       where d.deptype = 'o' and r.rolname in ${sql(runtimeRoles)}) as owned,
      (select count(*)::int
       from pg_catalog.pg_auth_members m
       join pg_catalog.pg_roles r on r.oid = m.member
       where r.rolname in ${sql(runtimeRoles)}) as memberships
  `;
  expect(counts).toEqual({ owned: 0, memberships: 0 });
});

it('refuses ff_app a switch to the app schema owner', async () => {
  const [{ owner }] = await sql<{ owner: string }[]>`
    select pg_catalog.pg_get_userbyid(nspowner) as owner
    from pg_catalog.pg_namespace
    where nspname = 'app'
  `;
  await expect(sql`set role ${sql(owner)}`).rejects.toMatchObject({ code: '42501' });
});
