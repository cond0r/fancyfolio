import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { parseDatabaseUrl, parseEnv } from '@fancyfolio/contracts';
import { Pool, type PoolConfig } from 'pg';
import * as v from 'valibot';

export const loopbackHosts = new Set(['127.0.0.1', 'localhost']);

const caEnv = v.object({
  DATABASE_CA_CERT: v.pipe(v.string(), v.includes('-----BEGIN CERTIFICATE-----')),
});

export function connectionOptions(url: string, env: Record<string, string | undefined>) {
  const target = parseDatabaseUrl(url);
  return {
    ...target,
    ssl: loopbackHosts.has(target.host)
      ? (false as const)
      : {
          ca: parseEnv(caEnv, env).DATABASE_CA_CERT,
          rejectUnauthorized: true,
          checkServerIdentity: (_servername: string, cert: PeerCertificate) =>
            checkServerIdentity(target.host, cert),
        },
  };
}

export function logConnectionError(): void {
  console.error('Database connection error');
}

type PoolLimits = Pick<
  PoolConfig,
  'max' | 'connectionTimeoutMillis' | 'query_timeout' | 'keepAlive'
>;

export function connect(url: string, limits: PoolLimits = {}): Pool {
  const pool = new Pool({ ...connectionOptions(url, process.env), ...limits });
  pool.on('error', logConnectionError);
  return pool;
}
