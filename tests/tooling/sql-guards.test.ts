import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const self = 'tests/tooling/sql-guards.test.ts';
const contextFile = 'packages/db/src/with-tenant.ts';
const migration = /^packages\/db\/drizzle\/[^/]+\.sql$/;
const script = /\.[cm]?[jt]sx?$/;
const testCode = /(^|\/)tests?\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const uncheckedSource = /^(apps\/[^/]+|packages\/db)\/src\/.*\.[cm]?jsx?$/;
const nestedBiomeConfig = /\/biome\.jsonc?$/;
const contextSetter = new RegExp(
  [
    String.raw`\bset_config\b`,
    String.raw`\bset\s+((local|session)\s+)?"?app"?\s*\.`,
    String.raw`\b(set|reset)\s+((local|session)\s+)?"?(statement_timeout|lock_timeout|idle_in_transaction_session_timeout)\b`,
    String.raw`-c(\s|%20|\+)*"?app"?(\.|%2e)`,
    String.raw`\bupdate\s+(pg_catalog\s*\.\s*)?pg_settings\b`,
  ].join('|'),
  'i',
);
const databaseModule = /^(postgres|pg)(\/|$)|^drizzle-orm\//;
const moduleLoads = new Set([
  'ImportDeclaration',
  'ImportExpression',
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
]);
const databasePackage = /^packages\/db\//;
const contextName = /^"?app"?\.(tenant_id|user_id)$/i;
const passedOn = new Set(['call', 'apply', 'bind']);

type Node = { type: string } & Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  );
}

function name(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
}

function walk(
  value: unknown,
  parent: Node | undefined,
  visit: (node: Node, parent?: Node) => void,
) {
  if (!isNode(value)) return;
  visit(value, parent);
  for (const child of Object.values(value)) {
    for (const item of Array.isArray(child) ? child : [child]) walk(item, value, visit);
  }
}

function scan(path: string, text: string) {
  const { program, errors } = parseSync(path, text, { preserveParens: false });
  const strings: string[] = [];
  const sqlNames = new Set(['sql']);
  const members: { node: Node; parent?: Node }[] = [];
  let raw = false;
  let driver = false;
  walk(program, undefined, (node, parent) => {
    const { value } = node;
    if (node.type === 'Literal' && typeof value === 'string') strings.push(value);
    if (node.type === 'TemplateElement' && typeof value === 'object' && value !== null) {
      if ('cooked' in value && typeof value.cooked === 'string') strings.push(value.cooked);
    }
    if (node.type === 'ImportSpecifier' && name(node.imported) === 'sql') {
      sqlNames.add(name(node.local) ?? 'sql');
    }
    if (node.type === 'VariableDeclarator' && sqlNames.has(name(node.init) ?? '')) {
      sqlNames.add(name(node.id) ?? 'sql');
    }
    if (moduleLoads.has(node.type) && node.importKind !== 'type' && node.exportKind !== 'type') {
      driver ||= databaseModule.test(name(node.source) ?? '');
    }
    raw ||= node.type === 'Identifier' && node.name === 'StringChunk';
    if (node.type === 'MemberExpression') members.push({ node, parent });
    if (node.type === 'Property' && parent?.type === 'ObjectPattern') {
      raw ||= ['raw', 'unsafe'].includes(name(node.key) ?? '');
    }
    if (node.type === 'CallExpression') {
      const callee = isNode(node.callee) ? name(node.callee.property) : undefined;
      raw ||= callee === 'file';
      raw ||= callee === 'raw' && isNode(node.callee) && name(node.callee.object) !== 'String';
    }
  });
  for (const { node, parent } of members) {
    const property = name(node.property);
    const object = isNode(node.object) ? node.object : undefined;
    const onSql =
      sqlNames.has(name(object) ?? '') ||
      (object?.type === 'MemberExpression' && name(object.property) === 'sql');
    const readFurther =
      parent?.type === 'MemberExpression' &&
      parent.object === node &&
      !passedOn.has(name(parent.property) ?? '');
    raw ||= (property === 'raw' && onSql) || (property === 'unsafe' && !readFurther);
  }
  return {
    parses: errors.length === 0,
    context: strings.some((value) => contextSetter.test(value) || contextName.test(value.trim())),
    raw,
    driver,
  };
}

function violations(path: string, text: string): string[] {
  if (path === self || migration.test(path)) return [];
  if (nestedBiomeConfig.test(path)) return [`${path}: nested Biome config`];
  if (path.endsWith('.sql')) {
    return contextSetter.test(text) ? [`${path}: sets app.* context outside withTenant`] : [];
  }
  if (!script.test(path)) return [];
  const { parses, context, raw, driver } = scan(path, text);
  const found = parses ? [] : [`${path}: does not parse`];
  if (context && path !== contextFile) found.push(`${path}: sets app.* context outside withTenant`);
  if (raw && !testCode.test(path)) found.push(`${path}: raw SQL`);
  if (driver && !testCode.test(path) && !databasePackage.test(path)) {
    found.push(`${path}: imports a database module outside packages/db`);
  }
  if (uncheckedSource.test(path)) found.push(`${path}: JavaScript source escapes the type check`);
  return found;
}

function read(path: string): string {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}

function repositoryFiles(): string[] {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout.split('\0').filter((path) => path !== '');
}

describe('the SQL guards', () => {
  it.each([
    [
      'apps/api/src/routes/site.ts',
      "await tx.execute(sql`select set_config('app.tenant_id', $1, true)`);",
      ['apps/api/src/routes/site.ts: sets app.* context outside withTenant'],
    ],
    [
      'packages/db/src/client.ts',
      "await tx.execute(sql`SELECT pg_catalog.SET_CONFIG('app.user_id', $1, true)`);",
      ['packages/db/src/client.ts: sets app.* context outside withTenant'],
    ],
    [
      'packages/db/test/isolation.test.ts',
      "await app`SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000'`;",
      ['packages/db/test/isolation.test.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/db.ts',
      "await app`set session app.user_id to 'x'`;",
      ['apps/api/src/db.ts: sets app.* context outside withTenant'],
    ],
    ['apps/api/src/db.ts', 'await db.execute(sql.raw(query));', ['apps/api/src/db.ts: raw SQL']],
    ['apps/api/src/db.ts', 'await client.unsafe(query);', ['apps/api/src/db.ts: raw SQL']],
    ['packages/db/src/query.ts', 'const run = sql.unsafe;', ['packages/db/src/query.ts: raw SQL']],
    [
      'apps/api/src/db.ts',
      'await app`SET LOCAL "app.tenant_id" = $1`;',
      ['apps/api/src/db.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/db.ts',
      'await tx.execute(sql`set "app".user_id = $1`);',
      ['apps/api/src/db.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/db.ts',
      'await app`SET\n  app . tenant_id = $1`;',
      ['apps/api/src/db.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/db.ts',
      "postgres({ ...options, connection: { 'app.tenant_id': tenantId } });",
      ['apps/api/src/db.ts: sets app.* context outside withTenant'],
    ],
    [
      'packages/db/test/with-tenant.test.ts',
      "const statement = { query: `select set_config('app.tenant_id', $1, true)`, params: [id] };",
      ['packages/db/test/with-tenant.test.ts: sets app.* context outside withTenant'],
    ],
    [
      'packages/db/drizzle/meta/seed.ts',
      "await tx.execute(sql`select set_config('app.tenant_id', $1, true)`);",
      ['packages/db/drizzle/meta/seed.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/site.ts',
      "import { sql as q } from 'drizzle-orm';\nawait db.execute(q.raw(query));",
      ['apps/api/src/site.ts: raw SQL'],
    ],
    [
      'apps/api/src/site.ts',
      "import * as orm from 'drizzle-orm';\nawait db.execute(orm.sql.raw(query));",
      ['apps/api/src/site.ts: raw SQL'],
    ],
    [
      'apps/api/src/site.ts',
      'const { raw } = sql;\nraw(query);',
      ['apps/api/src/site.ts: raw SQL'],
    ],
    [
      'apps/api/src/site.ts',
      'const { unsafe } = client;\nawait unsafe(query);',
      ['apps/api/src/site.ts: raw SQL'],
    ],
    [
      'apps/api/src/site.ts',
      'const rows = await client.unsafe<{ id: string }[]>(query);',
      ['apps/api/src/site.ts: raw SQL'],
    ],
    ['apps/api/src/site.ts', 'const run = client.unsafe;', ['apps/api/src/site.ts: raw SQL']],
    ['apps/api/src/site.ts', "await client.file('seed.sql');", ['apps/api/src/site.ts: raw SQL']],
    [
      'packages/db/src/with-tenant.ts',
      "await tx.execute(sql`select set_config('app.user_id', $1, true)`);",
      [],
    ],
    [
      'apps/api/src/site.ts',
      'await tx.execute(sql`select id from tenants where subdomain = $1`);',
      [],
    ],
    ['apps/api/src/site.ts', 'const body = await c.req.raw.text();', []],
    ['apps/api/src/site.ts', 'const path = String.raw`C:\\sites`;', []],
    [
      'packages/editor/src/dialect.ts',
      'const rules = toMarkdown.unsafe?.filter((rule) => rule.inConstruct);',
      [],
    ],
    [
      'packages/db/test/with-tenant.test.ts',
      "await single`select current_setting('app.tenant_id', true) as tenant`;",
      [],
    ],
    ['packages/db/drizzle/0009_reset.sql', "SELECT set_config('app.tenant_id', '', true);", []],
    [
      'packages/db/drizzle/0004_tenants-rls.sql',
      "SELECT nullif(current_setting('app.tenant_id', true), '')::uuid",
      [],
    ],
    ['packages/db/src/schema/tenants.ts', "check('subdomain', sql`subdomain ~ '^[a-z]+$'`)", []],
    ['packages/db/test/setup.ts', 'await owner.unsafe(statement);', []],
    ['apps/web/e2e/build.spec.ts', 'await client.unsafe(statement);', []],
    ['README.md', 'Only withTenant calls set_config.', []],
    ['apps/web/test/hosts.test.ts', "expect(matcher.test('app.fancyfolio.test')).toBe(true);", []],
    [
      'packages/db/src/with-tenant.ts',
      'await tx.execute(sql.raw(query));',
      ['packages/db/src/with-tenant.ts: raw SQL'],
    ],
    [
      'apps/api/src/site.ts',
      "import { sql } from 'drizzle-orm';\nconst q = sql;\nconst run = q.raw;",
      ['apps/api/src/site.ts: raw SQL'],
    ],
    [
      'apps/api/src/site.ts',
      "import { q } from '@fancyfolio/db';\nawait db.execute(q.raw(query));",
      ['apps/api/src/site.ts: raw SQL'],
    ],
    [
      'apps/api/src/site.ts',
      "import { SQL, StringChunk } from 'drizzle-orm';\nawait db.execute(new SQL([new StringChunk(query)]));",
      ['apps/api/src/site.ts: raw SQL'],
    ],
    [
      'apps/api/src/site.ts',
      "import * as orm from 'drizzle-orm';\nawait db.execute({ getSQL: () => new orm.SQL([new orm.StringChunk(query)]) });",
      ['apps/api/src/site.ts: raw SQL'],
    ],
    ['apps/api/src/site.ts', 'await client?.unsafe(query);', ['apps/api/src/site.ts: raw SQL']],
    [
      'apps/api/src/site.ts',
      "import { drizzle } from 'drizzle-orm/postgres-js';\nconst db = drizzle(client);",
      ['apps/api/src/site.ts: imports a database module outside packages/db'],
    ],
    [
      'apps/api/src/site.ts',
      'await tx.execute(sql`set local statement_timeout = 0`);',
      ['apps/api/src/site.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/site.ts',
      'await tx.execute(sql`SET idle_in_transaction_session_timeout TO 0`);',
      ['apps/api/src/site.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/site.ts',
      'await tx.execute(sql`reset lock_timeout`);',
      ['apps/api/src/site.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/db.ts',
      'postgres(url, { connection: { options: `-c app.tenant_id=${id}` } });',
      ['apps/api/src/db.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/db.ts',
      'const url = `${base}?options=-c%20app.tenant_id%3D${id}`;',
      ['apps/api/src/db.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/db.ts',
      'process.env.PGOPTIONS = \'-c "app".user_id=\' + id;',
      ['apps/api/src/db.ts: sets app.* context outside withTenant'],
    ],
    [
      'apps/api/src/db.ts',
      "await tx.execute(sql`update pg_settings set setting = ${id} where name = 'app.tenant_id'`);",
      ['apps/api/src/db.ts: sets app.* context outside withTenant'],
    ],
    [
      'packages/db/src/with-tenant.ts',
      "import { drizzle } from 'drizzle-orm/postgres-js';\nawait tx.execute(sql`select set_config('app.user_id', $1, true)`);",
      [],
    ],
    ['packages/db/test/setup.ts', "import { drizzle } from 'drizzle-orm/postgres-js';", []],
    [
      'apps/api/src/db.ts',
      "import postgres from 'postgres';",
      ['apps/api/src/db.ts: imports a database module outside packages/db'],
    ],
    [
      'apps/api/src/db.ts',
      "const { default: postgres } = await import('postgres');",
      ['apps/api/src/db.ts: imports a database module outside packages/db'],
    ],
    [
      'apps/api/src/db.ts',
      "export * from 'postgres';",
      ['apps/api/src/db.ts: imports a database module outside packages/db'],
    ],
    [
      'apps/api/src/db.ts',
      "export { default as postgres } from 'postgres';",
      ['apps/api/src/db.ts: imports a database module outside packages/db'],
    ],
    [
      'apps/api/src/db.ts',
      "import pg from 'pg';",
      ['apps/api/src/db.ts: imports a database module outside packages/db'],
    ],
    [
      'apps/api/src/db.ts',
      "import { PgTransaction } from 'drizzle-orm/pg-core';",
      ['apps/api/src/db.ts: imports a database module outside packages/db'],
    ],
    ['apps/api/src/db.ts', "import type { PgTransaction } from 'drizzle-orm/pg-core';", []],
    ['apps/api/src/db.ts', "export type { Sql } from 'postgres';", []],
    ['apps/api/src/db.ts', "import { eq, sql } from 'drizzle-orm';", []],
    ['apps/api/src/db.ts', "import pgvector from 'pgvector';", []],
    ['packages/db/src/client.ts', "import postgres from 'postgres';", []],
    ['packages/db/src/query.ts', "import { PgDialect } from 'drizzle-orm/pg-core';", []],
    ['apps/api/test/db.test.ts', "import postgres from 'postgres';", []],
    ['apps/api/src/auth.ts', 'export const handle = (c) => auth.handler(c.req.raw);', []],
    ['apps/api/src/site.ts', "const text = String.raw({ raw: ['a'] });", []],
    ['apps/api/src/site.ts', 'const broken = (;', ['apps/api/src/site.ts: does not parse']],
    ['apps/api/src/db.js', '', ['apps/api/src/db.js: JavaScript source escapes the type check']],
    [
      'apps/web/src/routes/site.mjs',
      '',
      ['apps/web/src/routes/site.mjs: JavaScript source escapes the type check'],
    ],
    [
      'packages/db/src/query.cjs',
      '',
      ['packages/db/src/query.cjs: JavaScript source escapes the type check'],
    ],
    [
      'packages/db/src/view.jsx',
      '',
      ['packages/db/src/view.jsx: JavaScript source escapes the type check'],
    ],
    [
      'apps/api/src/db.mjs',
      'await client.unsafe(query);',
      [
        'apps/api/src/db.mjs: raw SQL',
        'apps/api/src/db.mjs: JavaScript source escapes the type check',
      ],
    ],
    ['apps/web/postcss.config.mjs', '', []],
    ['apps/api/test/db.test.js', '', []],
    ['packages/contracts/src/reserved.js', '', []],
    ['apps/api/biome.json', '{}', ['apps/api/biome.json: nested Biome config']],
    ['packages/db/src/biome.jsonc', '{}', ['packages/db/src/biome.jsonc: nested Biome config']],
    ['biome.json', '{}', []],
    ['apps/api/src/.biome.json', '{}', []],
  ])('judges %s holding %j', (path, text, expected) => {
    expect(violations(path, text)).toEqual(expected);
  });

  it('reads a listed file missing from the working tree as empty and rethrows other errors', () => {
    expect(read('packages/db/src/missing.ts')).toBe('');
    expect(() => read('packages/db/src')).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });

  it('finds no context setter outside withTenant and no raw SQL in the repository', () => {
    const files = repositoryFiles();
    expect(files).toContain(self);
    expect(files.flatMap((path) => violations(path, read(path)))).toEqual([]);
  });
});
