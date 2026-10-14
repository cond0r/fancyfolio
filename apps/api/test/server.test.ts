import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

const apiDir = join(import.meta.dirname, '..');
let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('no TCP port assigned'));
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function spawnApi(port: string): ChildProcessByStdio<null, Readable, Readable> {
  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: apiDir,
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function listening(api: ChildProcessByStdio<null, Readable, Readable>): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let output = '';
    api.stdout.setEncoding('utf8');
    api.stderr.setEncoding('utf8');
    api.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      output += chunk;
      const match = /API listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) resolve(Number(match[1]));
    });
    api.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    api.once('close', (code, signal) => {
      reject(new Error(`API exited (code ${code}, signal ${signal}) before listening:\n${output}`));
    });
    api.once('error', reject);
  });
}

function fetchHealth(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
}

describe('the API server under Node type stripping', () => {
  it('refuses to start on a malformed PORT and never prints the value', async () => {
    const error = await listening(spawnApi('not-a-port-Q7')).then(
      () => 'listening',
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('API exited (code 1, signal null) before listening');
    expect(message).toContain('Invalid environment: PORT (malformed)');
    expect(message).not.toContain('not-a-port-Q7');
  });

  it('serves /api/health from TypeScript source without a build step', async () => {
    const port = await freePort();
    expect(await listening(spawnApi(String(port)))).toBe(port);
    const res = await fetchHealth(port);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('gives up on a health fetch the server never answers', async () => {
    const sockets: Socket[] = [];
    const silent = createServer((socket) => {
      sockets.push(socket);
    });
    const port = await listen(silent);
    try {
      await expect(fetchHealth(port)).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      for (const socket of sockets) socket.destroy();
      silent.close();
    }
  });
});
