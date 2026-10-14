import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const apiDir = join(import.meta.dirname, '..');
let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function waitForHealth(port: number): Promise<Response> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await fetch(`http://127.0.0.1:${port}/api/health`);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('the API server under Node type stripping', () => {
  it('refuses to start on a malformed PORT and never prints the value', () => {
    const result = spawnSync(process.execPath, ['src/server.ts'], {
      cwd: apiDir,
      env: { ...process.env, PORT: 'not-a-port-Q7' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid environment: PORT (malformed)');
    expect(`${result.stdout}${result.stderr}`).not.toContain('not-a-port-Q7');
  });

  it('serves /api/health from TypeScript source without a build step', async () => {
    const port = await freePort();
    child = spawn(process.execPath, ['src/server.ts'], {
      cwd: apiDir,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    const res = await waitForHealth(port);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
