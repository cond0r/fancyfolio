import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    projects: [{ test: { name: 'tooling', include: ['tests/tooling/**/*.test.ts'] } }],
  },
});
