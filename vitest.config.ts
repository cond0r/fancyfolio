import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    projects: [
      { test: { name: 'tooling', include: ['tests/tooling/**/*.test.ts'] } },
      { test: { name: 'contracts', root: 'packages/contracts', include: ['test/**/*.test.ts'] } },
      {
        test: {
          name: 'api',
          root: 'apps/api',
          include: ['test/**/*.test.ts'],
        },
      },
      { test: { name: 'editor', root: 'packages/editor', include: ['test/**/*.test.ts'] } },
      {
        test: {
          name: 'web',
          root: 'apps/web',
          include: ['test/**/*.test.ts'],
          env: { API_URL: 'http://127.0.0.1:3201', ROOT_DOMAIN: 'localhost' },
        },
      },
      {
        test: {
          name: 'db',
          root: 'packages/db',
          include: ['test/**/*.test.ts'],
          globalSetup: ['test/setup.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
