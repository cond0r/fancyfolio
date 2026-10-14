import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs';
import { join, matchesGlob, posix } from 'node:path';
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

  it('every test file under apps/ and packages/ is collected by a Vitest project', () => {
    const projects = (config.test?.projects ?? []).flatMap((entry) =>
      typeof entry === 'object' && !(entry instanceof Promise) && entry.test
        ? [
            {
              root: entry.test.root ?? '.',
              include: entry.test.include ?? [],
              exclude: entry.test.exclude ?? [],
            },
          ]
        : [],
    );
    const testFiles = globSync('{apps,packages}/*/**/*.test.{ts,tsx}', {
      cwd: root,
      exclude: (name) => name === 'node_modules',
    });
    const collected = (file: string) =>
      projects.some(
        (project) =>
          project.include.some((pattern) => matchesGlob(file, posix.join(project.root, pattern))) &&
          !project.exclude.some((pattern) => matchesGlob(file, posix.join(project.root, pattern))),
      );
    const uncollected = testFiles.filter((file) => !collected(file));
    expect(testFiles).toContain('apps/api/test/env.test.ts');
    expect(uncollected).toEqual([]);
  });
});
