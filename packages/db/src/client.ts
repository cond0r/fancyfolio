import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { parseEnv } from '@fancyfolio/contracts';
import postgres from 'postgres';
import * as v from 'valibot';

export const loopbackHosts = new Set(['127.0.0.1', 'localhost']);

const caEnv = v.object({
  DATABASE_CA_CERT: v.pipe(v.string(), v.includes('-----BEGIN CERTIFICATE-----')),
});

const refusal = 'Database URL must be postgres://user:password@host[:port]/database, nothing else';

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new Error(refusal);
  }
}

export function parseDatabaseUrl(url: string) {
  const parsed = URL.parse(url);
  if (
    parsed === null ||
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.hostname === '' ||
    /[,[]/.test(parsed.hostname) ||
    !/^\/[^/]+$/.test(parsed.pathname)
  ) {
    throw new Error(refusal);
  }
  const database = decodePart(parsed.pathname.slice(1));
  const username = decodePart(parsed.username);
  const password = decodePart(parsed.password);
  if (![database, username].every((part) => /^[^\p{Cc}]+$/u.test(part))) {
    throw new Error(refusal);
  }
  return {
    host: parsed.hostname.toLowerCase(),
    port: Number(parsed.port || 5432),
    database,
    username,
    password,
  };
}

export function connectionOptions(url: string, env: Record<string, string | undefined>) {
  const target = parseDatabaseUrl(url);
  return {
    ...target,
    prepare: false,
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

export function connect(url: string): postgres.Sql {
  return postgres(connectionOptions(url, process.env));
}
