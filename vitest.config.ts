import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    projects: [
      { test: { name: 'tooling', include: ['tests/tooling/**/*.test.ts'] } },
      {
        test: {
          name: 'api',
          root: 'apps/api',
          include: ['test/**/*.test.ts'],
        },
      },
      { test: { name: 'editor', root: 'packages/editor', include: ['test/**/*.test.ts'] } },
    ],
  },
});
