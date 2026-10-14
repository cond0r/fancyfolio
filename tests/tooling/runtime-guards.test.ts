import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const scratch = mkdtempSync(join(import.meta.dirname, 'guard-run-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(bin: string, args: string[]) {
  const result = spawnSync(join(root, 'node_modules', '.bin', bin), args, {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function biomeCheck(name: string, source: string) {
  const file = join(scratch, name);
  writeFileSync(file, source);
  return run('biome', ['check', '--colors=off', file]);
}

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
