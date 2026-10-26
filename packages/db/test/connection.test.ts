import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { inspect } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, connectionOptions } from '../src/client.ts';

const ca = '-----BEGIN CERTIFICATE-----\nMIIBfixture\n-----END CERTIFICATE-----\n';
const refused = 'Database URL must be postgres://user:password@host[:port]/database, nothing else';

describe('connectionOptions', () => {
  it('takes every connection field from the one parsed URL', () => {
    expect(
      connectionOptions('postgresql://ff_app.abcdef:p%40ss%2Fw%3Ard@127.0.0.1:6543/fancyfolio', {}),
    ).toEqual({
      host: '127.0.0.1',
      port: 6543,
      database: 'fancyfolio',
      user: 'ff_app.abcdef',
      password: 'p@ss/w:rd',
      ssl: false,
    });
  });

  it('reads a host list hidden in the user info as one host, the one after the last @', () => {
    expect(
      connectionOptions(
        'postgres://owner:pw@db.example.test:55433,x@127.0.0.1:1/fancyfolio_test',
        {},
      ),
    ).toMatchObject({ host: '127.0.0.1', port: 1, password: 'pw@db.example.test:55433,x' });
  });

  it.each([
    'postgres://owner:secret@localhost/fancyfolio_test',
    'postgres://owner:secret@LOCALHOST:5432/fancyfolio_test',
  ])('keeps the loopback connection %s plain without a CA', (url) => {
    expect(connectionOptions(url, {})).toMatchObject({ port: 5432, ssl: false });
  });

  it('refuses a non-loopback host without a CA and names the variable', () => {
    expect(() => connectionOptions('postgres://owner:secret@db.example.test/postgres', {})).toThrow(
      'Invalid environment: DATABASE_CA_CERT (missing)',
    );
    expect(() =>
      connectionOptions('postgres://owner:secret@127.0.0.2/postgres', {
        DATABASE_CA_CERT: 'not a certificate',
      }),
    ).toThrow('Invalid environment: DATABASE_CA_CERT (malformed)');
  });

  it('verifies the server certificate and host name against the CA for a non-loopback host', () => {
    expect(
      connectionOptions('postgres://owner:secret@db.example.test/postgres', {
        DATABASE_CA_CERT: ca,
      }),
    ).toMatchObject({
      host: 'db.example.test',
      port: 5432,
      ssl: { ca, rejectUnauthorized: true },
    });
  });

  it.each([
    'postgres://owner:secret@127.0.0.1/fancyfolio_test?database=victim',
    'postgres://owner:secret@db.example.test/postgres?sslmode=disable',
    'postgres://owner:secret@127.0.0.1/fancyfolio_test#x',
    'postgres://owner:secret@db.example.test:55433,127.0.0.1/fancyfolio_test',
    'postgres://owner:secret@db.example.test,127.0.0.1/fancyfolio_test',
    'postgres://owner:secret@[::1]:5432/fancyfolio_test',
    'postgres://owner:secret@127.0.0.1/',
    'postgres://owner:secret@127.0.0.1/fancyfolio_test/extra',
    'mysql://owner:secret@127.0.0.1/fancyfolio_test',
    'not a url secret',
    'postgres://:secret@127.0.0.1/fancyfolio_test',
    'postgres://own%er:secret@127.0.0.1/fancyfolio_test',
    'postgres://owner:sec%ret@127.0.0.1/fancyfolio_test',
    'postgres://owner:secret@127.0.0.1/fancyfolio%test',
    'postgres://owner%00options%00-c%20search_path%3Dpg_temp:secret@127.0.0.1/fancyfolio_test',
    'postgres://owner%0A:secret@127.0.0.1/fancyfolio_test',
    'postgres://owner:secret@127.0.0.1/fancyfolio_test%00application_name',
    'postgres://owner:secret@127.0.0.1/fancyfolio%7Ftest',
  ])('refuses %s without echoing it', (url) => {
    const error = (() => {
      try {
        connectionOptions(url, { DATABASE_CA_CERT: ca });
      } catch (caught: unknown) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ message: refused });
    expect(inspect(error, { depth: 10 })).not.toContain('secret');
  });
});

describe('connect', () => {
  it('opens nothing for a URL the options refuse or a remote host without a CA', () => {
    vi.stubEnv('DATABASE_CA_CERT', undefined);
    try {
      expect(() =>
        connect('postgres://owner:pw@127.0.0.1/fancyfolio_test?sslmode=disable'),
      ).toThrow(refused);
      expect(() => connect('postgres://owner:pw@db.example.test/postgres')).toThrow(
        'Invalid environment: DATABASE_CA_CERT (missing)',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the TLS handshake with a server named by its IP', () => {
  const host = '127.0.0.2';
  const fields = Buffer.from('SFATAL\0C28000\0Mfixture server\0\0');
  const errorResponse = Buffer.concat([Buffer.from('E'), Buffer.alloc(4), fields]);
  errorResponse.writeInt32BE(4 + fields.length, 1);
  const ecKey = '-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1';
  let dir = '';

  function openssl(command: string) {
    const child = spawnSync('openssl', command.split(' '), {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (child.status !== 0) throw new Error(`openssl failed: ${child.stderr}`);
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fancyfolio-tls-'));
    openssl(`req -x509 ${ecKey} -keyout ca.key -out ca.crt -subj /CN=fixture-ca`);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function handshake(subjectAltName: string) {
    openssl(
      `req -x509 -CA ca.crt -CAkey ca.key ${ecKey} -keyout server.key -out server.crt -subj /CN=fixture-db -addext subjectAltName=${subjectAltName}`,
    );
    const key = readFileSync(join(dir, 'server.key'));
    const cert = readFileSync(join(dir, 'server.crt'));
    let accepted = false;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('data', () => {
        socket.write('S');
        const secure = new TLSSocket(socket, { isServer: true, key, cert });
        secure.on('secure', () => {
          accepted = true;
          secure.end(errorResponse);
        });
        secure.on('error', () => secure.destroy());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    const client = new pg.Client({
      ...connectionOptions(`postgres://owner:pw@${host}:${address.port}/fancyfolio_test`, {
        DATABASE_CA_CERT: readFileSync(join(dir, 'ca.crt'), 'utf8'),
      }),
      connectionTimeoutMillis: 5000,
    });
    try {
      const error = await client.connect().catch((caught: unknown) => caught);
      return { accepted, error };
    } finally {
      await client.end();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('accepts a certificate from the CA that names the IP', async () => {
    expect(await handshake(`IP:${host}`)).toMatchObject({
      accepted: true,
      error: { code: '28000' },
    });
  });

  it('refuses a certificate from the CA that names only localhost', async () => {
    expect(await handshake('DNS:localhost')).toMatchObject({
      accepted: false,
      error: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    });
  });
});
