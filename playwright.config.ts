import { defineConfig, devices } from '@playwright/test';

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
  webServer: {
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
    },
    url: 'http://localhost:3200/api/health',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
