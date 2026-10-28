import { isSubdomain, RESERVED_SUBDOMAINS, SUBDOMAIN_PATTERN } from '@fancyfolio/contracts';
import { type ExtractTablesWithRelations, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgTransaction } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';
import { tenants } from '../src/schema/tenants.ts';
import { authTables } from './auth-tables.ts';
import { rows } from './fixtures.ts';

const app = connect(inject('db').appUrl);
const db = drizzle(app);
const runtimeRoles = ['ff_app', 'ff_auth', 'ff_resolver'];
const supabaseRoles = ['anon', 'authenticated', 'service_role'];
const contentTables = ['case_studies', 'experiences', 'profiles', 'projects'];
const resolverFunctions = [
  'app.domains_to_recheck(integer)',
  'app.record_txt(text,text,boolean)',
  'app.resolve_site(text)',
];
const tenantTables = ['tenants', 'domains', ...contentTables];
const scoped = '(tenant_id = ( SELECT app.tenant_id() AS tenant_id))';
const owned = `(${scoped} AND ( SELECT app.is_owner() AS is_owner))`;

const probes = [..."az09-AZ_. \n\t'%/\\", 'é', 'а', 'ı', '​', 'ａ', '\u{1f600}'];
const corpus = [
  ...new Set([
    'ines',
    'abc',
    '123',
    'a-b',
    'abc--d',
    'ab--cd',
    'xn--80ak6aa92e',
    'xn--ines',
    '-ines',
    'ines-',
    'Ines',
    '%69nes',
    "ines'--",
    "a'); drop table tenants; --",
    ...RESERVED_SUBDOMAINS,
    ...RESERVED_SUBDOMAINS.map((name) => name.toUpperCase()),
    ...RESERVED_SUBDOMAINS.map((name) => `${name}-x`),
    ...Array.from({ length: 40 }, (_, index) => 'a'.repeat(index + 1)),
    ...probes.flatMap((probe) => [`${probe}abcd`, `ab${probe}cd`, `abcd${probe}`]),
  ]),
];

type Grant = { schema: string; kind: string; name: string; grantee: string; privilege: string };

type Transaction = NodePgTransaction<
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

const executableDefiners = (on: NodePgDatabase | Transaction) =>
  rows(on)(sql`
      select r.rolname as role, p.oid::regprocedure::text as name
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join pg_roles r
      where p.prosecdef and r.rolname in ${runtimeRoles}
        and has_schema_privilege(r.oid, n.oid, 'USAGE')
        and has_function_privilege(r.oid, p.oid, 'EXECUTE')
    `);

const resolverDefiners = ['ff_app', 'ff_resolver'].flatMap((role) =>
  resolverFunctions.map((name) => ({ role, name })),
);

afterAll(() => app.end());

describe('roles', () => {
  it('runs on Postgres 17', async () => {
    const [{ major }] = await rows(db)(
      sql`select current_setting('server_version_num')::int / 10000 as major`,
    );
    expect(major).toBe(17);
  });

  it('keeps role settings off the runtime roles in every database', async () => {
    const settings = await rows(db)(sql`
      select r.rolname, s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
      where r.rolname in ${runtimeRoles}
    `);
    expect(settings).toEqual([]);
  });

  it('keeps the runtime roles off superuser and BYPASSRLS, and the resolver off login', async () => {
    const roles = await rows(db)(sql`
      select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles
      where rolname in ${runtimeRoles} order by rolname
    `);
    expect(roles).toEqual([
      { rolname: 'ff_app', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: 'ff_auth', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: 'ff_resolver', rolsuper: false, rolbypassrls: false, rolcanlogin: false },
    ]);
  });

  it('runs migrations as an owner with NOSUPERUSER BYPASSRLS, as on Supabase', async () => {
    const [ownerRole] = await rows(db)(sql`
      select rolsuper, rolbypassrls from pg_roles
      where oid = (select nspowner from pg_namespace where nspname = 'app')
    `);
    expect(ownerRole).toEqual({ rolsuper: false, rolbypassrls: true });
  });

  it('lets the runtime roles own only the resolver functions and belong to no role', async () => {
    const owned = await rows(db)(sql`
      select r.rolname as role, pg_describe_object(d.classid, d.objid, d.objsubid) as object
      from pg_shdepend d join pg_roles r on r.oid = d.refobjid
      where d.refclassid = 'pg_authid'::regclass and d.deptype = 'o'
        and d.dbid = (select oid from pg_database where datname = current_database())
        and r.rolname in ${runtimeRoles}
      order by 2
    `);
    expect(owned).toEqual(
      resolverFunctions.map((name) => ({ role: 'ff_resolver', object: `function ${name}` })),
    );
    const [{ memberships }] = await rows(db)(sql`
      select count(*)::int as memberships from pg_auth_members m join pg_roles r on r.oid = m.member
      where r.rolname in ${runtimeRoles}
    `);
    expect(memberships).toBe(0);
  });

  it('leaves the migrator unable to act as ff_resolver after handing it the functions', async () => {
    const [migrator] = await rows(db)(sql`
      select pg_has_role(n.nspowner, 'ff_resolver', 'SET') as set,
        pg_has_role(n.nspowner, 'ff_resolver', 'USAGE') as usage
      from pg_namespace n where n.nspname = 'app'
    `);
    expect(migrator).toEqual({ set: false, usage: false });
  });

  it('refuses SET ROLE to the owner for ff_app', async () => {
    const [{ owner }] = await rows<{ owner: string }>(db)(sql`
      select r.rolname as owner from pg_namespace n join pg_roles r on r.oid = n.nspowner
      where n.nspname = 'app'
    `);
    await expect(
      db.transaction((tx) => tx.execute(sql`set local role ${sql.identifier(owner)}`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('tables and privileges', () => {
  let grants: Grant[] = [];

  beforeAll(async () => {
    grants = await rows<Grant>(db)(sql`
      with acls as (
        select n.nspname as schema, c.relkind::text as kind, c.relname as name,
          coalesce(
            c.relacl,
            acldefault(case c.relkind when 'S' then 's' else 'r' end::"char", c.relowner)
          ) as acl
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        union all
        select n.nspname, c.relkind::text, c.relname || '.' || a.attname, a.attacl
        from pg_attribute a join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
        where a.attacl is not null
        union all
        select n.nspname, 'function',
          p.oid::regprocedure::text, coalesce(p.proacl, acldefault('f', p.proowner))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      )
      select a.schema, a.kind, a.name,
        case when e.grantee = 0 then 'PUBLIC' else e.grantee::regrole::text end as grantee,
        e.privilege_type as privilege
      from acls a, aclexplode(a.acl) e
      where left(a.schema, 3) <> 'pg_' and a.schema <> 'information_schema'
    `);
  });

  it('takes the auth tables from the Better Auth schema', () => {
    expect(authTables).toEqual([
      'accounts',
      'apikeys',
      'rate_limits',
      'sessions',
      'users',
      'verifications',
    ]);
  });

  it('forces RLS with at least one policy on every table in public and app', async () => {
    const tables = await rows(db)(sql`
      select c.relname as name,
        c.relrowsecurity and c.relforcerowsecurity
          and exists (select 1 from pg_policy p where p.polrelid = c.oid) as guarded
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'app') and c.relkind in ('r', 'p')
      order by c.relname
    `);
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([...authTables, ...tenantTables]),
    );
    expect(tables.filter((table) => !table.guarded)).toEqual([]);
  });

  it('stores every timestamp in public and app with its time zone', async () => {
    const naive = await rows(db)(sql`
      select c.relname || '.' || a.attname as name
      from pg_attribute a join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'app') and a.atttypid = 'timestamp'::regtype
        and a.attnum > 0 and not a.attisdropped
    `);
    expect(naive).toEqual([]);
  });

  it('gives each auth table one permissive policy for ff_auth over all rows', async () => {
    const policies = await rows(db)(sql`
      select tablename, roles::text[] as roles, cmd, permissive, qual, with_check
      from pg_policies where schemaname = 'public' and tablename in ${authTables}
      order by tablename
    `);
    expect(policies).toEqual(
      authTables.map((tablename) => ({
        tablename,
        roles: ['ff_auth'],
        cmd: 'ALL',
        permissive: 'PERMISSIVE',
        qual: 'true',
        with_check: 'true',
      })),
    );
  });

  it('grants the auth tables to ff_auth for SELECT, INSERT, UPDATE and DELETE only', async () => {
    const grants = await rows(db)(sql`
      select c.relname as table, a.grantee::regrole::text as grantee,
        string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
        aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public' and c.relname in ${authTables} and a.grantee <> c.relowner
      group by c.relname, a.grantee order by c.relname
    `);
    expect(grants).toEqual(
      authTables.map((table) => ({
        table,
        grantee: 'ff_auth',
        privileges: 'DELETE,INSERT,SELECT,UPDATE',
      })),
    );
  });

  it('gives tenants a SELECT and an INSERT policy for ff_app and a SELECT policy for ff_resolver', async () => {
    const policies = await rows(db)(sql`
      select policyname, roles::text[] as roles, cmd, permissive, qual, with_check
      from pg_policies where schemaname = 'public' and tablename = 'tenants'
      order by policyname
    `);
    expect(policies).toEqual([
      {
        policyname: 'tenants_insert',
        roles: ['ff_app'],
        cmd: 'INSERT',
        permissive: 'PERMISSIVE',
        qual: null,
        with_check:
          '((id = ( SELECT app.tenant_id() AS tenant_id)) AND (owner_id = ( SELECT app.user_id() AS user_id)))',
      },
      {
        policyname: 'tenants_resolve',
        roles: ['ff_resolver'],
        cmd: 'SELECT',
        permissive: 'PERMISSIVE',
        qual: 'true',
        with_check: null,
      },
      {
        policyname: 'tenants_select',
        roles: ['ff_app'],
        cmd: 'SELECT',
        permissive: 'PERMISSIVE',
        qual: '((id = ( SELECT app.tenant_id() AS tenant_id)) OR (owner_id = ( SELECT app.user_id() AS user_id)))',
        with_check: null,
      },
    ]);
  });

  it('shows ff_app a domain only while live or to its owner, and lets ff_resolver update only verified rows', async () => {
    const policies = await rows(db)(sql`
      select policyname, roles::text[] as roles, cmd, qual, with_check
      from pg_policies where schemaname = 'public' and tablename = 'domains'
      order by policyname
    `);
    expect(policies).toEqual([
      {
        policyname: 'domains_recheck',
        roles: ['ff_resolver'],
        cmd: 'UPDATE',
        qual: '(verified_at IS NOT NULL)',
        with_check: 'true',
      },
      {
        policyname: 'domains_resolve',
        roles: ['ff_resolver'],
        cmd: 'SELECT',
        qual: 'true',
        with_check: null,
      },
      {
        policyname: 'domains_select',
        roles: ['ff_app'],
        cmd: 'SELECT',
        qual: `(${scoped} AND (app.domain_live(verified_at, checked_at) OR ( SELECT app.is_owner() AS is_owner)))`,
        with_check: null,
      },
      {
        policyname: 'domains_write',
        roles: ['ff_app'],
        cmd: 'ALL',
        qual: owned,
        with_check: owned,
      },
    ]);
  });

  it('grants domains to ff_app and only the resolver columns to ff_resolver', () => {
    const held = (name: string) =>
      grants
        .filter((grant) => grant.schema === 'public' && grant.name.split('.')[0] === name)
        .filter((grant) => runtimeRoles.includes(grant.grantee))
        .map(({ name, grantee, privilege }) => `${grantee} ${privilege} ${name}`)
        .sort();
    expect(held('domains')).toEqual([
      'ff_app DELETE domains',
      'ff_app INSERT domains',
      'ff_app SELECT domains',
      'ff_app UPDATE domains',
      'ff_resolver SELECT domains.challenge_token',
      'ff_resolver SELECT domains.checked_at',
      'ff_resolver SELECT domains.hostname',
      'ff_resolver SELECT domains.tenant_id',
      'ff_resolver SELECT domains.verified_at',
      'ff_resolver UPDATE domains.checked_at',
      'ff_resolver UPDATE domains.verified_at',
    ]);
    expect(held('tenants')).toEqual([
      'ff_app INSERT tenants',
      'ff_app SELECT tenants',
      'ff_resolver SELECT tenants.id',
      'ff_resolver SELECT tenants.subdomain',
    ]);
    expect(
      grants.filter(
        (grant) =>
          grant.grantee === 'ff_resolver' &&
          grant.kind !== 'function' &&
          !['domains', 'tenants'].includes(grant.name.split('.')[0]),
      ),
    ).toEqual([]);
  });

  it('grants tenants to ff_app for SELECT and INSERT only', async () => {
    const grants = await rows(db)(sql`
      select a.grantee::regrole::text as grantee,
        string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
      from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where c.oid = to_regclass('public.tenants') and a.grantee <> c.relowner
      group by a.grantee
    `);
    expect(grants).toEqual([{ grantee: 'ff_app', privileges: 'INSERT,SELECT' }]);
  });

  it('lists every function in app with its owner, mode, empty search_path and executors', async () => {
    const functions = await rows(db)(sql`
      select p.proname as name,
        case when p.proowner = n.nspowner then 'migrator' else p.proowner::regrole::text end as owner,
        p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config,
        array(
          select e.grantee::regrole::text
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
          where e.grantee <> p.proowner order by 1
        ) as executors
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
      order by p.proname
    `);
    const fn = (name: string, volatility: string, executors: string[]) => ({
      name,
      owner: 'migrator',
      definer: false,
      volatility,
      config: ['search_path=""'],
      executors,
    });
    const resolver = (name: string, volatility: string) => ({
      ...fn(name, volatility, ['ff_app']),
      owner: 'ff_resolver',
      definer: true,
    });
    expect(functions).toEqual([
      fn('clear_source_hash', 'v', []),
      fn('domain_live', 's', ['ff_app', 'ff_resolver']),
      resolver('domains_to_recheck', 's'),
      fn('guard_domain_claim', 'v', []),
      fn('is_owner', 's', ['ff_app']),
      fn('links_valid', 'i', ['ff_app']),
      resolver('record_txt', 'v'),
      fn('require_recheck_job', 's', ['ff_resolver']),
      resolver('resolve_site', 's'),
      fn('tags_valid', 'i', ['ff_app']),
      fn('tenant_id', 's', ['ff_app']),
      fn('touch', 'v', []),
      fn('user_id', 's', ['ff_app']),
    ]);
  });

  it('gives each content table one read and one owner-only write policy for ff_app', async () => {
    const policies = await rows(db)(sql`
      select tablename, policyname, roles::text[] as roles, cmd, permissive, qual, with_check
      from pg_policies where schemaname = 'public' and tablename in ${contentTables}
      order by tablename, policyname
    `);
    expect(policies).toEqual(
      contentTables.flatMap((tablename) => [
        {
          tablename,
          policyname: `${tablename}_select`,
          roles: ['ff_app'],
          cmd: 'SELECT',
          permissive: 'PERMISSIVE',
          qual:
            tablename === 'case_studies'
              ? `(${scoped} AND ((published_at IS NOT NULL) OR ( SELECT app.is_owner() AS is_owner)))`
              : scoped,
          with_check: null,
        },
        {
          tablename,
          policyname: `${tablename}_write`,
          roles: ['ff_app'],
          cmd: 'ALL',
          permissive: 'PERMISSIVE',
          qual: owned,
          with_check: owned,
        },
      ]),
    );
  });

  it('grants the content tables to ff_app, profiles without DELETE', async () => {
    const grants = await rows(db)(sql`
      select c.relname as table, a.grantee::regrole::text as grantee,
        string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
        aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public' and c.relname in ${contentTables} and a.grantee <> c.relowner
      group by c.relname, a.grantee order by c.relname
    `);
    expect(grants).toEqual(
      contentTables.map((table) => ({
        table,
        grantee: 'ff_app',
        privileges: table === 'profiles' ? 'INSERT,SELECT,UPDATE' : 'DELETE,INSERT,SELECT,UPDATE',
      })),
    );
  });

  it('keeps updated_at and the domain claim in BEFORE INSERT OR UPDATE and source_hash in BEFORE UPDATE row triggers', async () => {
    const triggers = await rows(db)(sql`
      select c.relname as table, t.tgname as name, t.tgfoid::regproc::text as function, t.tgtype
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal order by c.relname, t.tgname
    `);
    const beforeUpdateRow = 1 | 2 | 16;
    const beforeInsertOrUpdateRow = beforeUpdateRow | 4;
    const touch = (table: string) => ({
      table,
      name: `${table}_touch`,
      function: 'app.touch',
      tgtype: beforeInsertOrUpdateRow,
    });
    expect(triggers).toEqual([
      {
        table: 'case_studies',
        name: 'case_studies_clear_source_hash',
        function: 'app.clear_source_hash',
        tgtype: beforeUpdateRow,
      },
      touch('case_studies'),
      {
        table: 'domains',
        name: 'domains_guard_claim',
        function: 'app.guard_domain_claim',
        tgtype: beforeInsertOrUpdateRow,
      },
      touch('domains'),
      ...['experiences', 'profiles', 'projects'].map(touch),
    ]);
  });

  it('links a case study to an experience of its own tenant, nulling only the link on delete', async () => {
    const [link] = await rows(db)(sql`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = to_regclass('public.case_studies') and contype = 'f'
        and conname = 'case_studies_experience_fk'
    `);
    expect(link).toEqual({
      definition:
        'FOREIGN KEY (tenant_id, experience_id) REFERENCES experiences(tenant_id, id) ON DELETE SET NULL (experience_id)',
    });
  });

  it('grants nothing in public or app to PUBLIC, anon, authenticated or service_role', () => {
    const outsiders = ['PUBLIC', ...supabaseRoles];
    expect(
      grants.filter(
        (grant) => ['public', 'app'].includes(grant.schema) && outsiders.includes(grant.grantee),
      ),
    ).toEqual([]);
  });

  it('holds the runtime roles to SELECT, INSERT, UPDATE and DELETE on any table or column', () => {
    expect(
      grants.filter(
        (grant) =>
          ['r', 'p'].includes(grant.kind) &&
          runtimeRoles.includes(grant.grantee) &&
          !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(grant.privilege),
      ),
    ).toEqual([]);
  });

  it('gives the runtime roles nothing on views, sequences or any relation but a table', () => {
    expect(
      grants.filter(
        (grant) =>
          !['r', 'p', 'function'].includes(grant.kind) && runtimeRoles.includes(grant.grantee),
      ),
    ).toEqual([]);
  });

  it('lets only ff_app and their owner execute the resolver functions, the only SECURITY DEFINER ones', async () => {
    expect(await executableDefiners(db)).toEqual(expect.arrayContaining(resolverDefiners));
    expect(await executableDefiners(db)).toHaveLength(resolverDefiners.length);
  });

  it('sets an empty search_path on every SECURITY DEFINER function in public and app', async () => {
    const unpinned = await rows(db)(sql`
      select p.oid::regprocedure::text as name
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'app') and p.prosecdef
        and not coalesce('search_path=""' = any(p.proconfig), false)
    `);
    expect(unpinned).toEqual([]);
  });

  it('keeps the runtime roles out of every schema but public and app', async () => {
    const reachable = await rows(db)(sql`
      select r.rolname, n.nspname from pg_roles r cross join pg_namespace n
      where r.rolname in ${runtimeRoles} and has_schema_privilege(r.oid, n.oid, 'USAGE')
        and left(n.nspname, 3) <> 'pg_'
        and n.nspname not in ('information_schema', 'public', 'app')
    `);
    expect(reachable).toEqual([]);
  });

  it('keeps the runtime roles from creating objects in public or app', async () => {
    const creators = await rows(db)(sql`
      select r.rolname, s.schema from pg_roles r
        cross join (values ('public'), ('app')) as s(schema)
      where r.rolname in ${runtimeRoles} and has_schema_privilege(r.oid, s.schema, 'CREATE')
    `);
    expect(creators).toEqual([]);
  });

  it('keeps the runtime roles from creating temporary tables that shadow public ones', async () => {
    const temporary = await rows(db)(sql`
      select rolname from pg_roles
      where rolname in ${runtimeRoles}
        and has_database_privilege(oid, current_database(), 'TEMPORARY')
    `);
    expect(temporary).toEqual([]);
  });

  it('sets default privileges so new tables, sequences and functions in public and app go to nobody else', async () => {
    const defaults = await rows(db)(sql`
      with owner as (select nspowner as oid from pg_namespace where nspname = 'app')
      select n.nspname as schema, k.objtype::text as kind, e.grantee, e.privilege_type
      from owner, pg_namespace n cross join (values ('r'::"char"), ('S'::"char"), ('f'::"char")) as k(objtype),
        aclexplode(
          coalesce(
            (select d.defaclacl from pg_default_acl d where d.defaclrole = owner.oid
              and d.defaclnamespace = 0 and d.defaclobjtype = k.objtype),
            acldefault(k.objtype, owner.oid)
          ) || coalesce(
            (select d.defaclacl from pg_default_acl d where d.defaclrole = owner.oid
              and d.defaclnamespace = n.oid and d.defaclobjtype = k.objtype),
            '{}'::aclitem[]
          )
        ) e
      where n.nspname in ('public', 'app') and e.grantee <> owner.oid
    `);
    expect(defaults).toEqual([]);
  });
});

describe.runIf(inject('db').mode === 'local')('the SECURITY DEFINER check', () => {
  it('reports a definer a runtime role can run and skips one in a schema it cannot use', async () => {
    const owner = connect(inject('db').ownerUrl);
    const rollback = new Error('rollback');
    let found: unknown[] = [];
    try {
      await expect(
        drizzle(owner).transaction(async (tx) => {
          await tx.execute(sql`create schema vendor_helpers`);
          await tx.execute(sql`
            create function vendor_helpers.lookup() returns int
            language sql security definer set search_path = '' as 'select 1'
          `);
          await tx.execute(sql`grant execute on function vendor_helpers.lookup() to public`);
          await tx.execute(sql`
            create function public.escalate() returns int
            language sql security definer set search_path = '' as 'select 1'
          `);
          await tx.execute(sql`grant execute on function public.escalate() to ff_app`);
          found = await executableDefiners(tx);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(found).toEqual(
        expect.arrayContaining([...resolverDefiners, { role: 'ff_app', name: 'escalate()' }]),
      );
      expect(found).toHaveLength(resolverDefiners.length + 1);
    } finally {
      await owner.end();
    }
  });
});

describe('the subdomain CHECK', () => {
  it('holds in the database exactly the pattern and reserved names of the contracts', async () => {
    const quoted = (value: string) => `'${value.replaceAll("'", "''")}'::text`;
    const [{ definition }] = await rows<{ definition: string }>(db)(sql`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = to_regclass('public.tenants') and conname = 'tenants_subdomain_check'
    `);
    expect(definition).toBe(
      `CHECK (((subdomain ~ ${quoted(SUBDOMAIN_PATTERN)}) AND (subdomain <> ALL (ARRAY[${RESERVED_SUBDOMAINS.map(quoted).join(', ')}]))))`,
    );
  });

  it('gets the same verdict from the contract and from the generated CHECK on every string', async () => {
    const [constraint] = getTableConfig(tenants).checks;
    const answers = await rows<{ value: string; accepted: boolean }>(db)(
      sql`select "subdomain" as value, (${constraint.value}) as accepted from unnest(${sql.param(corpus)}::text[]) as "tenants"("subdomain")`,
    );
    const verdicts = answers.map(({ value, accepted }) => ({
      value,
      contract: isSubdomain(value),
      database: accepted,
    }));
    expect(verdicts.map(({ value }) => value)).toEqual(corpus);
    expect(verdicts.filter((verdict) => verdict.contract !== verdict.database)).toEqual([]);
    expect(verdicts.filter((verdict) => verdict.database).length).toBeGreaterThan(50);
    expect(verdicts.filter((verdict) => !verdict.database).length).toBeGreaterThan(100);
  });
});
