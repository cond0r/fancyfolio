import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.ts';

const root = join(import.meta.dirname, '..', '..');

const packages = ['apps', 'packages'].flatMap((group) =>
  readdirSync(join(root, group), { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(root, group, entry.name, 'package.json')),
    )
    .map((entry) => `${group}/${entry.name}`),
);

describe('workspace packages', () => {
  it.each(packages)('%s has a typecheck script', (path) => {
    const pkg: { scripts?: Record<string, string> } = JSON.parse(
      readFileSync(join(root, path, 'package.json'), 'utf8'),
    );
    expect(pkg.scripts?.typecheck).toBe('tsc -p .');
  });

  it('every package with a test directory is a Vitest project root', () => {
    const roots = (config.test?.projects ?? []).flatMap((entry) =>
      typeof entry === 'object' && !(entry instanceof Promise) && entry.test?.root
        ? [entry.test.root]
        : [],
    );
    const withTests = packages.filter((path) => existsSync(join(root, path, 'test')));
    expect(withTests).toContain('apps/api');
    expect(roots).toEqual(expect.arrayContaining(withTests));
  });
});
