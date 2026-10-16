import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const tempTrees: string[] = [];

afterAll(() => {
  for (const dir of tempTrees) rmSync(dir, { recursive: true, force: true });
});

function lintAt(path: string, source: string) {
  const tree = mkdtempSync(join(tmpdir(), 'ff-lint-'));
  tempTrees.push(tree);
  copyFileSync(join(root, 'biome.json'), join(tree, 'biome.json'));
  mkdirSync(dirname(join(tree, path)), { recursive: true });
  writeFileSync(join(tree, path), source);
  const result = spawnSync(
    join(root, 'node_modules', '.bin', 'biome'),
    ['lint', '--colors=off', '--vcs-use-ignore-file=false', path],
    { cwd: tree, encoding: 'utf8', timeout: 20_000 },
  );
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`biome stopped by signal ${result.signal}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const web = 'apps/web';
const editorRoutes = [
  'apps/web/app/(app)/dashboard/case-studies/[id]',
  'apps/web/app/(app)/playground',
];
const contracts = 'packages/contracts';
const markdownFile = 'apps/web/lib/markdown.tsx';

const serverOnly = [
  ['@fancyfolio/db', 'Only apps/api talks to the database.'],
  ['@fancyfolio/db/schema', 'Only apps/api talks to the database.'],
  ['postgres', 'Only apps/api talks to the database.'],
  ['drizzle-orm', 'Only apps/api talks to the database.'],
  ['drizzle-orm/pg-core', 'Only apps/api talks to the database.'],
  ['@vercel/blob', 'Only apps/api talks to Vercel Blob.'],
  ['@vercel/blob/client', 'Only apps/api talks to Vercel Blob.'],
  ['better-auth', 'Only apps/api runs the Better Auth server'],
  ['better-auth/adapters/drizzle', 'Only apps/api runs the Better Auth server'],
  ['better-auth/client/../api', 'Only apps/api runs the Better Auth server'],
  ['better-auth/client/plugins/../../api', 'Only apps/api runs the Better Auth server'],
  ['@better-auth/api-key', 'Only apps/api runs the Better Auth server'],
  ['@better-auth/core/db', 'Only apps/api runs the Better Auth server'],
  ['pg', 'Only apps/api talks to the database.'],
  ['pg/lib/client', 'Only apps/api talks to the database.'],
  ['../../packages/db', 'Only apps/api talks to the database.'],
  ['../../../packages/db/src/schema.ts', 'Only apps/api talks to the database.'],
  ['@fancyfolio/api', 'apps/api is a server: reach it over HTTP.'],
  ['@fancyfolio/api/src/env.ts', 'apps/api is a server: reach it over HTTP.'],
  ['../../apps/api', 'apps/api is a server: reach it over HTTP.'],
  ['../../apps/api/src/index.ts', 'apps/api is a server: reach it over HTTP.'],
  ['bun', 'Node is the runtime'],
  ['bun:sqlite', 'Node is the runtime'],
] as const;

const editor = [
  ['@fancyfolio/editor', 'The editor loads only on the case-study edit route and the playground.'],
  [
    '@fancyfolio/editor/dialect',
    'The editor loads only on the case-study edit route and the playground.',
  ],
] as const;

const framework = [
  ['hono', 'Contracts stay framework-free'],
  ['hono/client', 'Contracts stay framework-free'],
  ['@hono/node-server', 'Contracts stay framework-free'],
  ['@hono/node-server/serve-static', 'Contracts stay framework-free'],
] as const;

function expectBanned(path: string, specifier: string, message: string) {
  const result = lintAt(
    path,
    `import * as banned from '${specifier}';\n\nexport const value = banned;\n`,
  );
  expect(result.output).toContain('lint/style/noRestrictedImports');
  expect(result.output).toContain(message);
  expect(result.status).not.toBe(0);
}

function expectAllowed(path: string, source: string) {
  const result = lintAt(path, source);
  expect(result.output).not.toContain('lint/');
  expect(result.status).toBe(0);
}

describe('server-only and editor import bans', { timeout: 30_000 }, () => {
  describe('apps/web cannot import server-only packages', () => {
    it('passes the imports the web needs', () => {
      expectAllowed(
        `${web}/fixture.ts`,
        "import { healthResponse } from '@fancyfolio/contracts';\nimport { createAuthClient } from 'better-auth/react';\nimport { hc } from 'hono/client';\nimport Link from 'next/link';\n\nexport const used = [healthResponse, createAuthClient, hc, Link];\n",
      );
    });

    it('passes relative imports inside the web', () => {
      expectAllowed(
        `${web}/app/fixture.ts`,
        "import { env } from '../env.ts';\nimport Page from './page.tsx';\n\nexport const used = [env, Page];\n",
      );
    });

    it.each(['../api', '../db/client.ts'])(
      'passes a local %s folder inside the web',
      (specifier) => {
        expectAllowed(
          `${web}/lib/sub/fixture.ts`,
          `import * as local from '${specifier}';\n\nexport const value = local;\n`,
        );
      },
    );

    it.each([...serverOnly, ...editor])('refuses %s', (specifier, message) => {
      expectBanned(`${web}/fixture.ts`, specifier, message);
    });

    it('refuses dynamic imports and re-exports of a banned package', () => {
      const result = lintAt(
        `${web}/fixture.ts`,
        "export * from 'postgres';\n\nexport const driver = await import('drizzle-orm');\n",
      );
      expect(result.output.match(/lint\/style\/noRestrictedImports/g)).toHaveLength(2);
    });
  });

  describe.each(editorRoutes)('%s', (dir) => {
    it('may import the editor', () => {
      expectAllowed(
        `${dir}/fixture.ts`,
        "import * as editor from '@fancyfolio/editor';\n\nexport const value = editor;\n",
      );
    });

    it.each(serverOnly)('still refuses %s', (specifier, message) => {
      expectBanned(`${dir}/fixture.ts`, specifier, message);
    });
  });

  describe('the editor exception is exactly the edit route and the playground', () => {
    it.each([
      'apps/web/app/(app)/dashboard/case-studies/new',
      'apps/web/app/(app)/dashboard',
      'apps/web/app',
    ])('refuses the editor in %s', (dir) => {
      expectBanned(`${dir}/fixture.ts`, '@fancyfolio/editor', editor[0][1]);
    });
  });

  describe('apps/web/lib/markdown.tsx may import the editor dialect only', () => {
    it('lets apps/web/lib/markdown.tsx import @fancyfolio/editor/dialect', () => {
      expectAllowed(
        markdownFile,
        "import * as dialect from '@fancyfolio/editor/dialect';\n\nexport const value = dialect;\n",
      );
    });

    const refused: ReadonlyArray<readonly [string, string]> = [
      ['@fancyfolio/editor', editor[0][1]],
      ['@fancyfolio/editor/core', editor[0][1]],
      ...serverOnly,
    ];

    it.each(refused)('still refuses %s in apps/web/lib/markdown.tsx', (specifier, message) => {
      expectBanned(markdownFile, specifier, message);
    });

    it.each([
      'apps/web/lib/markdown.ts',
      'apps/web/lib/render/markdown.tsx',
      'apps/web/components/markdown.tsx',
      'apps/web/app/sites/[site]/page.tsx',
    ])('refuses @fancyfolio/editor/dialect in %s', (path) => {
      expectBanned(path, '@fancyfolio/editor/dialect', editor[1][1]);
    });
  });

  describe('packages/contracts stays free of servers and frameworks', () => {
    it('passes the validator', () => {
      expectAllowed(
        `${contracts}/fixture.ts`,
        "import * as v from 'valibot';\nimport { parseEnv } from './env.ts';\n\nexport const used = [v.string(), parseEnv];\n",
      );
    });

    it.each([...serverOnly, ...framework])('refuses %s', (specifier, message) => {
      expectBanned(`${contracts}/fixture.ts`, specifier, message);
    });
  });

  describe('the bans are scoped', () => {
    it('lets apps/api import the database driver and Better Auth', () => {
      expectAllowed(
        'apps/api/fixture.ts',
        "import postgres from 'postgres';\nimport { betterAuth } from 'better-auth';\n\nexport const used = [postgres, betterAuth];\n",
      );
    });
  });
});

describe('type assertions in server source', { timeout: 30_000 }, () => {
  const header =
    "declare const input: string;\ndeclare const query: { for(strength: 'update' | 'share'): void };\n";
  const serverSource = ['apps/api/src/fixture.ts', 'packages/db/src/fixture.ts'];
  const elsewhere = ['apps/web/lib/fixture.ts', 'packages/db/test/fixture.test.ts'];
  const escapes = [
    ["query.for(input as 'update');", 'lint/nursery/noUnsafeTypeAssertion'],
    ['query.for(input as never);', 'lint/nursery/noUnsafeTypeAssertion'],
    ['export const count = input as unknown as number;', 'lint/nursery/noUnsafeTypeAssertion'],
    ["query.for(<'update'>input);", 'lint/nursery/noUnsafeTypeAssertion'],
    ['export const loose: any = input;', 'lint/suspicious/noExplicitAny'],
  ];

  it.each(serverSource.flatMap((path) => escapes.map(([line, rule]) => [path, line, rule])))(
    'refuses in %s: %s',
    (path, line, rule) => {
      const result = lintAt(path, `${header}${line}\n`);
      expect(result.output).toContain(rule);
      expect(result.status).not.toBe(0);
    },
  );

  it.each(serverSource)('passes as const in %s', (path) => {
    expectAllowed(path, "export const strengths = ['update', 'share'] as const;\n");
  });

  it.each(elsewhere.flatMap((path) => escapes.map(([line]) => [path, line])))(
    'leaves %s alone: %s',
    (path, line) => {
      expect(lintAt(path, `${header}${line}\n`).status).toBe(0);
    },
  );
});
