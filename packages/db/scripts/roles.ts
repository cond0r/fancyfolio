import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { parseEnv } from '@fancyfolio/contracts';
import * as v from 'valibot';

const rolePassword = v.pipe(v.string(), v.regex(/^[\x21-\x7e]{32,128}$/));

export const roleEnv = v.object({
  FF_APP_PASSWORD: rolePassword,
  FF_AUTH_PASSWORD: rolePassword,
});

type Statement = (strings: TemplateStringsArray, ...values: string[]) => PromiseLike<unknown>;

export type RoleSql = { begin(run: (tx: Statement) => Promise<void>): PromiseLike<unknown> };

const iterations = 4096;

export function scramVerifier(secret: string, salt = randomBytes(16)): string {
  const salted = pbkdf2Sync(secret, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

function failure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  // a PostgresError carries the verifier in its where and parameters
  if (error.name === 'PostgresError') return `SQLSTATE ${code}`;
  return code === undefined ? error.message : `${code}: ${error.message}`;
}

async function setLoginPassword(role: string, statement: PromiseLike<unknown>): Promise<void> {
  try {
    await statement;
  } catch (error) {
    throw new Error(`Could not set the login password for ${role} (${failure(error)})`);
  }
}

export async function setRolePasswords(
  sql: RoleSql,
  source: Record<string, string | undefined>,
): Promise<void> {
  const env = parseEnv(roleEnv, source);
  await sql.begin(async (tx) => {
    await tx`
      create function app.set_login_password(role_name text, verifier text)
      returns void
      language plpgsql
      set search_path = ''
      as $$
      begin
        execute format('alter role %I with login password %L', role_name, verifier);
      end
      $$
    `;
    await setLoginPassword(
      'ff_app',
      tx`select app.set_login_password('ff_app', ${scramVerifier(env.FF_APP_PASSWORD)})`,
    );
    await setLoginPassword(
      'ff_auth',
      tx`select app.set_login_password('ff_auth', ${scramVerifier(env.FF_AUTH_PASSWORD)})`,
    );
    await tx`drop function app.set_login_password(text, text)`;
  });
}
