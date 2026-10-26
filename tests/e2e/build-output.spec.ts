import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const nextDir = join(import.meta.dirname, '..', '..', 'apps', 'web', '.next');

function readBuildFile(...path: string[]) {
  return readFileSync(join(nextDir, ...path), 'utf8');
}

test('the build ran with Cache Components, Partial Prefetching, typed routes and the React Compiler', () => {
  const { config } = JSON.parse(readBuildFile('required-server-files.json'));
  expect(config).toMatchObject({
    cacheComponents: true,
    partialPrefetching: true,
    typedRoutes: true,
    reactCompiler: true,
  });
});

test('the build has no rewrites; Vercel routes /api/* to the api service', () => {
  const { rewrites } = JSON.parse(readBuildFile('routes-manifest.json'));
  expect(rewrites).toEqual({ beforeFiles: [], afterFiles: [], fallback: [] });
});

test('the landing page is prerendered static', () => {
  const { routes } = JSON.parse(readBuildFile('prerender-manifest.json'));
  expect(routes['/']).toMatchObject({ compute: 'static', response: 'complete' });
});

test('the landing page ships no client module of its own', () => {
  const source = readBuildFile('server', 'app', 'page_client-reference-manifest.js');
  const start = source.indexOf('{', source.indexOf('["/page"]'));
  const manifest = JSON.parse(source.slice(start, source.lastIndexOf('}') + 1));
  const modules = Object.keys(manifest.clientModules);
  expect(modules.length).toBeGreaterThan(0);
  for (const module of modules) expect(module).toMatch(/\/node_modules\/next\/dist\//);
});
