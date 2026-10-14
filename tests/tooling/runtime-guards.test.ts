import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const scratchParent = join(import.meta.dirname, '.scratch');
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(join(scratchParent, 'guard-run-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(bin: string, args: string[]) {
  const result = spawnSync(join(root, 'node_modules', '.bin', bin), args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`${bin} stopped by signal ${result.signal}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function biomeCheck(name: string, source: string) {
  const file = join(scratch, name);
  writeFileSync(file, source);
  return run('biome', ['check', '--vcs-enabled=false', '--colors=off', file]);
}

describe('the guard runner', () => {
  it('fails when a tool cannot start', () => {
    expect(() => run('missing-tool', [])).toThrow('ENOENT');
  });

  it('leaves fixtures that the project Biome run ignores', () => {
    const file = join(scratch, 'leftover.ts');
    writeFileSync(file, 'export const version = Bun.version;\n');
    const result = run('biome', ['check', '--colors=off', file]);
    expect(result.output).toContain('These paths were provided but ignored');
    expect(result.output).not.toContain('lint/');
  });
});

describe('the lint config bans Bun', () => {
  it('passes a Node-only module', () => {
    const result = biomeCheck('node-only.ts', 'export const runtime = process.version;\n');
    expect(result.output).not.toContain('lint/');
    expect(result.status).toBe(0);
  });

  it.each([
    [
      'bun-module.ts',
      'lint/style/noRestrictedImports',
      "import { serve } from 'bun';\n\nexport const start = serve;\n",
    ],
    [
      'bun-builtin.ts',
      'lint/style/noRestrictedImports',
      "import { Database } from 'bun:sqlite';\n\nexport const db = new Database(':memory:');\n",
    ],
    ['bun-global.ts', 'lint/style/noRestrictedGlobals', 'export const version = Bun.version;\n'],
  ])('fails %s with %s', (name, rule, source) => {
    const result = biomeCheck(name, source);
    expect(result.output).toContain(rule);
    expect(result.status).not.toBe(0);
  });
});

function typecheck(name: string, source: string) {
  const config = join(scratch, `tsconfig.${name}.json`);
  writeFileSync(join(scratch, `${name}.ts`), source);
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(root, 'tests', 'tooling', 'tsconfig.json'),
      files: [`${name}.ts`],
    }),
  );
  return run('tsc', ['-p', config]);
}

describe('TypeScript allows only Node types and erasable syntax', () => {
  it('type-checks a module that uses Node globals', () => {
    const result = typecheck('node-types', 'export const runtime: string = process.version;\n');
    expect(result.output).not.toContain('error TS');
    expect(result.status).toBe(0);
  });

  it('rejects an enum', () => {
    const result = typecheck('enum', 'export enum Mode {\n  On,\n  Off,\n}\n');
    expect(result.output).toContain('erasableSyntaxOnly');
    expect(result.status).not.toBe(0);
  });

  it('rejects the Bun global', () => {
    const result = typecheck('bun-global', 'export const version = Bun.version;\n');
    expect(result.output).toContain("Cannot find name 'Bun'");
    expect(result.status).not.toBe(0);
  });
});
