import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const db = join(import.meta.dirname, '..');
const committed = join(db, 'src', 'schema', 'auth.ts');

it('is the Better Auth CLI output for the generation config, with time zones, formatted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-schema-'));
  try {
    const output = join(dir, 'auth.ts');
    const generate = spawnSync(
      join(db, 'node_modules', '.bin', 'auth'),
      ['generate', '--config', 'scripts/auth-schema.config.ts', '--output', output, '--yes'],
      { cwd: db, encoding: 'utf8' },
    );
    expect(generate.status, generate.stderr).toBe(0);
    const format = spawnSync(
      join(db, '..', '..', 'node_modules', '.bin', 'biome'),
      ['check', '--write', `--stdin-file-path=${committed}`],
      {
        cwd: db,
        input: readFileSync(output, 'utf8').replaceAll(
          /timestamp\("(\w+)"\)/g,
          'timestamp("$1", { withTimezone: true })',
        ),
        encoding: 'utf8',
      },
    );
    expect(format.status, format.stderr).toBe(0);
    expect(format.stdout).toBe(readFileSync(committed, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
