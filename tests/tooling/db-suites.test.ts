import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

it('puts the database suites into the default test run that CI starts', () => {
  const pkg: { scripts: Record<string, string> } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  expect(pkg.scripts.test).toBe('vitest run');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')),
  );
  const list = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', '--json'],
    { cwd: root, env, encoding: 'utf8', timeout: 25_000 },
  );
  expect(list.status, list.stderr).toBe(0);
  const files: { file: string; projectName: string }[] = JSON.parse(list.stdout);
  const db = files
    .filter((entry) => entry.projectName === 'db')
    .map((entry) => entry.file.slice(root.length + 1));
  expect(db).toEqual(
    expect.arrayContaining(
      ['auth-schema', 'catalog', 'client', 'connection', 'harness', 'roles'].map(
        (suite) => `packages/db/test/${suite}.test.ts`,
      ),
    ),
  );
});
