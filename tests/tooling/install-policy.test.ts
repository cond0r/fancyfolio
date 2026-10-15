import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function pnpmConfig(key: string): string {
  const result = spawnSync('pnpm', ['config', 'get', key], {
    cwd: join(import.meta.dirname, '..', '..'),
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm config get ${key} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe('the install policy', () => {
  it('holds new releases for a day and refuses trust downgrades', () => {
    expect(pnpmConfig('minimumReleaseAge')).toBe('1440');
    expect(pnpmConfig('minimumReleaseAgeStrict')).toBe('true');
    expect(pnpmConfig('trustPolicy')).toBe('no-downgrade');
    expect(pnpmConfig('minimumReleaseAgeExclude')).toBe('undefined');
    expect(pnpmConfig('trustPolicyExclude')).toBe('[\n  "semver@6.3.1"\n]');
  });
});
