import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { parseEnv } from '@fancyfolio/contracts';
import { DrizzleQueryError, type SQL, sql } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import * as v from 'valibot';

const rolePassword = v.pipe(v.string(), v.regex(/^[\x21-\x7e]{32,128}$/));

export const roleEnv = v.object({
  FF_APP_PASSWORD: rolePassword,
  FF_AUTH_PASSWORD: rolePassword,
});

type Statements = { execute(query: SQL): PromiseLike<unknown> };

export type RoleSql = { transaction(run: (tx: Statements) => Promise<void>): PromiseLike<unknown> };

const iterations = 4096;

export function scramVerifier(secret: string, salt = randomBytes(16)): string {
  const salted = pbkdf2Sync(secret, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

function failure(error: unknown): string {
  const thrown = error instanceof DrizzleQueryError ? error.cause : error;
  if (!(thrown instanceof Error)) return String(thrown);
  const code = 'code' in thrown && typeof thrown.code === 'string' ? thrown.code : undefined;
  // the query error carries the verifier in its params, the DatabaseError in its where
  if (thrown instanceof DatabaseError) return `SQLSTATE ${code}`;
  return code === undefined ? thrown.message : `${code}: ${thrown.message}`;
}

async function setLoginPassword(role: string, statement: PromiseLike<unknown>): Promise<void> {
  try {
    await statement;
  } catch (error) {
    throw new Error(`Could not set the login password for ${role} (${failure(error)})`);
  }
}

export async function setRolePasswords(
  db: RoleSql,
  source: Record<string, string | undefined>,
): Promise<void> {
  const env = parseEnv(roleEnv, source);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      create function app.set_login_password(role_name text, verifier text)
      returns void
      language plpgsql
      set search_path = ''
      as $$
      begin
        execute format('alter role %I with login password %L', role_name, verifier);
      end
      $$
    `);
    await setLoginPassword(
      'ff_app',
      tx.execute(
        sql`select app.set_login_password('ff_app', ${scramVerifier(env.FF_APP_PASSWORD)})`,
      ),
    );
    await setLoginPassword(
      'ff_auth',
      tx.execute(
        sql`select app.set_login_password('ff_auth', ${scramVerifier(env.FF_AUTH_PASSWORD)})`,
      ),
    );
    await tx.execute(sql`drop function app.set_login_password(text, text)`);
  });
}
