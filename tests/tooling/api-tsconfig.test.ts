import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

describe('api tsconfig', () => {
  it('typechecks from a tsconfig in the temp dir that extends it, as the Vercel Node builder does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-api-build-'));
    try {
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          extends: join(root, 'apps/api/tsconfig.json'),
          include: [join(root, 'apps/api/src/index.ts')],
        }),
      );
      const result = spawnSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', dir], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(`${result.stdout}${result.stderr}`).toBe('');
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
