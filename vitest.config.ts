import { configDefaults, defineConfig } from 'vitest/config';

const revalidateEnv = { REVALIDATE_SECRET: 'unused-revalidate-secret-Z7-0123456789abcdef' };

const apiEnv = {
  AUTH_DATABASE_URL: 'postgres://ff_auth:unused-password-Z7@127.0.0.1:1/fancyfolio',
  BETTER_AUTH_SECRET: 'unused-auth-secret-Z7-0123456789abcdef',
  BETTER_AUTH_URL: 'http://localhost:3200',
  CLIENT_IP_HEADER: 'x-forwarded-for',
  WEB_URL: 'http://127.0.0.1:1',
  ...revalidateEnv,
};

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
          exclude: [...configDefaults.exclude, 'test/db/**'],
          env: {
            DATABASE_URL: 'postgres://ff_app:unused-password-Z7@127.0.0.1:1/fancyfolio',
            ROOT_DOMAIN: 'fancyfolio.test',
            ...apiEnv,
          },
        },
      },
      {
        test: {
          name: 'editor',
          root: 'packages/editor',
          include: ['test/**/*.test.ts'],
          css: { include: [/palette\.css/] },
        },
      },
      {
        test: { name: 'web', root: 'apps/web', include: ['test/**/*.test.ts'], env: revalidateEnv },
      },
      {
        test: {
          name: 'db',
          root: 'packages/db',
          include: ['test/**/*.test.ts', '../../apps/api/test/db/**/*.test.ts'],
          globalSetup: ['test/setup.ts'],
          fileParallelism: false,
          env: { ROOT_DOMAIN: 'fancyfolio.test', ...apiEnv },
        },
      },
    ],
  },
});
