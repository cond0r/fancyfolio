import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const tempTrees: string[] = [];

afterAll(() => {
  for (const dir of tempTrees) rmSync(dir, { recursive: true, force: true });
});

const serverDirs = ['apps/api', 'packages/db'];
const serverPackages = ['postgres', 'pg', 'drizzle-orm', '@vercel/blob'];

const boundaries = {
  'apps/web': serverPackages,
  'packages/contracts': [...serverPackages, 'hono', '@hono'],
};

type Project = keyof typeof boundaries;
const projects = Object.keys(boundaries) as Project[];

const bannedSamples: Record<Project, string[]> = {
  'apps/web': ['postgres', 'pg', 'drizzle-orm', '@vercel/blob'],
  'packages/contracts': [
    'postgres',
    'pg',
    'drizzle-orm',
    '@vercel/blob',
    'hono',
    '@hono/node-server',
  ],
};

const sourceExtensions = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];

const entry = (project: Project) =>
  join(root, project, project === 'apps/web' ? 'env.ts' : 'src/index.ts');

function crossings(project: Project, files: string[]) {
  const inPackage = new RegExp(`/node_modules/(?:@types/)?(?:${boundaries[project].join('|')})/`);
  return files.filter(
    (file) =>
      serverDirs.some((dir) => file.startsWith(`${join(root, dir)}/`)) || inPackage.test(file),
  );
}

function run(command: string, args: string[], cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  const call = [command, ...args].join(' ');
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`${call} stopped by signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`${call} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

function sourceFiles(dir: string) {
  const pathspecs = sourceExtensions.map((extension) => `*.${extension}`);
  return run(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', ...pathspecs],
    dir,
  )
    .split('\0')
    .filter(Boolean)
    .map((file) => join(dir, file));
}

function listFiles(project: Project, sources: string[]) {
  const configDir = mkdtempSync(join(tmpdir(), 'ff-resolve-config-'));
  tempTrees.push(configDir);
  const config = join(configDir, 'tsconfig.json');
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(root, project, 'tsconfig.json'),
      compilerOptions: { allowJs: true, typeRoots: [join(root, 'node_modules', '@types')] },
      include: [],
      files: sources,
    }),
  );
  return run(join(root, 'node_modules', '.bin', 'tsc'), ['-p', config, '--listFilesOnly'])
    .split('\n')
    .filter(Boolean);
}

const storeDir = (name: string) => `.pnpm/${name.replace('/', '+')}@1.0.0/node_modules/${name}`;

function fakePackage(tree: string, name: string) {
  const dir = join(tree, 'node_modules', storeDir(name));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      exports: { types: './index.d.ts', default: './index.js' },
    }),
  );
  writeFileSync(join(dir, 'index.d.ts'), 'export declare const value: number;\n');
  writeFileSync(join(dir, 'index.js'), 'export const value = 1;\n');
  mkdirSync(dirname(join(tree, 'node_modules', name)), { recursive: true });
  symlinkSync(dir, join(tree, 'node_modules', name));
}

function fixtureTree(project: Project) {
  const tree = mkdtempSync(join(tmpdir(), 'ff-resolve-'));
  tempTrees.push(tree);
  run('git', ['init', '--quiet'], tree);
  for (const name of bannedSamples[project]) fakePackage(tree, name);
  writeFileSync(join(tree, '.gitignore'), 'node_modules/\nbuild/\n');
  writeFileSync(join(tree, 'package.json'), '{"type":"module"}\n');
  return tree;
}

function writeSource(tree: string, path: string, source: (toRoot: string) => string) {
  const file = join(tree, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${source(relative(dirname(file), root))}\n`);
  return file;
}

function filesWithFixture(project: Project, path: string, source: (toRoot: string) => string) {
  const tree = fixtureTree(project);
  const fixture = writeSource(tree, path, source);
  const files = listFiles(project, sourceFiles(tree));
  expect(files).toContain(fixture);
  expect(files).not.toContain(entry(project));
  return files;
}

const reachingApi = [
  ['a dot segment', (toRoot: string) => `import * as m from '${toRoot}/apps/./api/src/env.ts';`],
  ['a doubled slash', (toRoot: string) => `import * as m from '${toRoot}/apps//api/src/env.ts';`],
  [
    'a parent segment',
    (toRoot: string) => `import * as m from '${toRoot}/apps/web/../api/src/env.ts';`,
  ],
  [
    'a template-literal dynamic import',
    (toRoot: string) => `const m = await import(\`${toRoot}/apps/api/src/env.ts\`);`,
  ],
] as const;

const reachingPackage = [
  [
    'the pnpm store',
    (name: string) => `import * as m from './node_modules/${storeDir(name)}/index.js';`,
  ],
  ['a template-literal dynamic import', (name: string) => `const m = await import(\`${name}\`);`],
] as const;

const importApi = (toRoot: string) => `import * as m from '${toRoot}/apps/api/src/env.ts';`;
const requireApi = (toRoot: string) => `require('${toRoot}/apps/api/src/env.ts');`;

describe.each(projects)('%s resolves no file across its boundary', (project) => {
  it('lists every source file git does not ignore and none across the boundary', () => {
    const sources = sourceFiles(join(root, project));
    const files = listFiles(project, sources);
    expect(sources).toContain(entry(project));
    expect(files).toEqual(expect.arrayContaining(sources));
    expect(crossings(project, files)).toEqual([]);
  });

  it('skips files git ignores', () => {
    const tree = fixtureTree(project);
    const fixture = writeSource(tree, 'fixture.ts', () => 'export const value = 1;');
    const ignored = writeSource(tree, 'build/loader.ts', importApi);
    const files = listFiles(project, sourceFiles(tree));
    expect(files).toContain(fixture);
    expect(files).not.toContain(ignored);
    expect(crossings(project, files)).toEqual([]);
  });

  it.each(reachingApi)('catches apps/api reached through %s', (_, importLine) => {
    const files = filesWithFixture(project, 'fixture.ts', importLine);
    expect(crossings(project, files)).toContain(join(root, 'apps/api/src/env.ts'));
  });

  describe.each(bannedSamples[project])('catches %s', (name) => {
    it.each(reachingPackage)('reached through %s', (_, importLine) => {
      const files = filesWithFixture(project, 'fixture.ts', () => importLine(name));
      expect(
        crossings(project, files).some((file) => file.endsWith(`/node_modules/${name}/index.d.ts`)),
      ).toBe(true);
    });
  });

  it.each([
    ['ts', importApi],
    ['tsx', importApi],
    ['mts', importApi],
    ['cts', importApi],
    ['js', importApi],
    ['jsx', importApi],
    ['mjs', importApi],
    ['cjs', requireApi],
  ])('catches apps/api reached from a nested .%s file', (extension, source) => {
    const files = filesWithFixture(project, `scripts/loader.${extension}`, source);
    expect(crossings(project, files)).toContain(join(root, 'apps/api/src/env.ts'));
  });

  it('catches a file under packages/db', () => {
    const file = join(root, 'packages/db/src/schema.ts');
    expect(crossings(project, [file])).toEqual([file]);
  });
});

describe.each(['hono', '@hono/node-server'])('framework package %s', (name) => {
  it('apps/web may resolve it, packages/contracts may not', () => {
    const file = join(root, 'node_modules', storeDir(name), 'dist/index.d.ts');
    expect(crossings('apps/web', [file])).toEqual([]);
    expect(crossings('packages/contracts', [file])).toEqual([file]);
  });
});
