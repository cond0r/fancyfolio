import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const webDir = join(import.meta.dirname, '..');

async function loadConfig(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  return (await import('../next.config.ts')).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('next.config.ts', () => {
  it('turns on Cache Components, Partial Prefetching, typed routes and the React Compiler', async () => {
    const config = await loadConfig({});
    expect(config).toMatchObject({
      cacheComponents: true,
      partialPrefetching: true,
      typedRoutes: true,
      reactCompiler: true,
      transpilePackages: ['@fancyfolio/contracts'],
    });
  });

  it('rewrites /api/* to the API only on the app host', async () => {
    const config = await loadConfig({
      API_URL: 'https://api.example.test',
      ROOT_DOMAIN: 'app.fancyfolio.test',
    });
    expect(await config.rewrites?.()).toEqual([
      {
        source: '/api/:path*',
        has: [{ type: 'host', value: 'app\\.fancyfolio\\.test' }],
        destination: 'https://api.example.test/api/:path*',
      },
    ]);
  });

  it('matches the host condition literally, the way Next applies it', async () => {
    const config = await loadConfig({ ROOT_DOMAIN: 'app.fancyfolio.test' });
    const rules = await config.rewrites?.();
    if (!Array.isArray(rules)) throw new Error('expected a rewrite array');
    const condition = rules[0]?.has?.[0];
    if (condition?.type !== 'host') throw new Error('expected a host condition');
    const matcher = new RegExp(`^${condition.value}$`);
    expect(matcher.test('app.fancyfolio.test')).toBe(true);
    for (const host of [
      'appXfancyfolio.test',
      'app.fancyfolioXtest',
      'evil.app.fancyfolio.test',
      'app.fancyfolio.test.evil.test',
    ]) {
      expect(matcher.test(host)).toBe(false);
    }
  });

  it('stops next build before compiling when the environment is invalid, without printing the value', () => {
    const result = spawnSync(join(webDir, 'node_modules', '.bin', 'next'), ['build'], {
      cwd: webDir,
      env: { ...process.env, ROOT_DOMAIN: 'Leaky-Q9:3000', NEXT_TELEMETRY_DISABLED: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain('Invalid environment: ROOT_DOMAIN (malformed)');
    expect(output).not.toContain('Leaky-Q9');
    expect(output).not.toContain('Creating an optimized production build');
  });
});
