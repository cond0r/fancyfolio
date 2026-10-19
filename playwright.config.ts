import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: Boolean(process.env.CI),
  use: { baseURL: 'http://localhost:3200' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node src/server.ts',
      cwd: 'apps/api',
      env: {
        PORT: '3201',
        DATABASE_URL: 'postgres://ff_app:unused-password-Z7@127.0.0.1:1/fancyfolio',
      },
      url: 'http://127.0.0.1:3201/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port 3200',
      cwd: 'apps/web',
      env: { API_URL: 'http://127.0.0.1:3201', ROOT_DOMAIN: 'localhost' },
      url: 'http://127.0.0.1:3200/',
      timeout: 240_000,
      reuseExistingServer: false,
    },
  ],
});
