import { defineConfig, devices } from '@playwright/test';

const liveblocks = 'http://localhost:1153';

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: Boolean(process.env.CI),
  use: { baseURL: 'http://localhost:3200' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      testMatch: 'editor/**',
      grepInvert: /@ime/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testMatch: 'editor/**',
      grepInvert: /@ime/,
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: [
    {
      command: 'apps/api/node_modules/.bin/liveblocks dev --port 1153 --no-persist --no-check',
      port: 1153,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      reuseExistingServer: false,
    },
    {
      command:
        'pnpm --filter ./apps/web build && npx -y vercel@64.5.0 dev --local --yes --listen 127.0.0.1:3200',
      env: {
        DATABASE_URL: 'postgres://ff_app:unused-password-Z7@127.0.0.1:1/fancyfolio',
        AUTH_DATABASE_URL: 'postgres://ff_auth:unused-password-Z7@127.0.0.1:1/fancyfolio',
        BETTER_AUTH_SECRET: 'unused-auth-secret-Z7-0123456789abcdef',
        BETTER_AUTH_URL: 'http://localhost:3200',
        CLIENT_IP_HEADER: 'x-forwarded-for',
        ROOT_DOMAIN: 'localhost',
        VERCEL_TELEMETRY_DISABLED: '1',
        LIVEBLOCKS_SECRET_KEY: 'sk_localdev',
        LIVEBLOCKS_BASE_URL: liveblocks,
        NEXT_PUBLIC_LIVEBLOCKS_BASE_URL: liveblocks,
      },
      url: 'http://localhost:3200/api/health',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      timeout: 300_000,
      reuseExistingServer: false,
    },
  ],
});
