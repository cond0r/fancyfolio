import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: Boolean(process.env.CI),
  use: { baseURL: 'http://localhost:3200' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'pnpm --filter ./apps/web build && npx -y vercel@64.5.0 dev --local --yes --listen 127.0.0.1:3200',
    env: {
      DATABASE_URL: 'postgres://ff_app:unused-password-Z7@127.0.0.1:1/fancyfolio',
      VERCEL_TELEMETRY_DISABLED: '1',
    },
    url: 'http://127.0.0.1:3200/api/health',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
