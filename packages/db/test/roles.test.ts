import { inspect } from 'node:util';
import { DrizzleQueryError, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { type RoleSql, scramVerifier, setRolePasswords } from '../scripts/roles.ts';

const verifier = /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;

const dialect = new PgDialect();

function fakeSql(send: (text: string, params: unknown[]) => void): RoleSql {
  return {
    async transaction(run) {
      await run({
        async execute(query: SQL) {
          const { sql, params } = dialect.sqlToQuery(query);
          send(sql, params);
        },
      });
    },
  };
}

function recordingSql() {
  const texts: string[] = [];
  const values: unknown[] = [];
  const sql = fakeSql((text, params) => {
    texts.push(text);
    values.push(...params);
  });
  return { sql, texts, values };
}

describe('scramVerifier', () => {
  it('matches the RFC 7677 derivation for a fixed salt', () => {
    expect(scramVerifier('pencil-pencil-pencil-pencil-pencil', Buffer.alloc(16, 7))).toBe(
      'SCRAM-SHA-256$4096:BwcHBwcHBwcHBwcHBwcHBw==$5gn3Svx5TdQcJKaTl4fvgFrY6WHgdhtDIrSZjKoRS5k=:lTRK1xFw2CsOnAp9ryZq/9e19D1O3bLLMoLh2prHMCo=',
    );
  });
});

describe('setRolePasswords', () => {
  it('binds one SCRAM verifier per role and sends no password', async () => {
    const passwords = {
      FF_APP_PASSWORD: 'tangerine-lantern-orbit-velvet-41',
      FF_AUTH_PASSWORD: 'test-auth-password-not-secret-0001',
    };
    const fake = recordingSql();
    await setRolePasswords(fake.sql, passwords);
    expect(fake.values).toHaveLength(2);
    for (const value of fake.values) expect(value).toMatch(verifier);
    for (const sent of [...fake.texts, ...fake.values.map(String)]) {
      expect(sent).not.toContain(passwords.FF_APP_PASSWORD);
      expect(sent).not.toContain(passwords.FF_AUTH_PASSWORD);
    }
  });

  it.each([
    {
      thrown: new DrizzleQueryError(
        'select app.set_login_password($1, $2)',
        ['ff_app', 'SCRAM-SHA-256$4096:fixture'],
        Object.assign(new DatabaseError('permission denied', 0, 'error'), { code: '42501' }),
      ),
      reason: 'SQLSTATE 42501',
    },
    {
      thrown: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      reason: 'ECONNRESET: read ECONNRESET',
    },
    {
      thrown: Object.assign(new Error('socket hang up'), { code: undefined }),
      reason: 'socket hang up',
    },
  ])('reports $reason for an error thrown as $thrown.name', async ({ thrown, reason }) => {
    const sql = fakeSql((text) => {
      if (text.includes("set_login_password('ff_app'")) throw thrown;
    });
    const error = await setRolePasswords(sql, {
      FF_APP_PASSWORD: 'a'.repeat(32),
      FF_AUTH_PASSWORD: 'b'.repeat(32),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: `Could not set the login password for ff_app (${reason})`,
    });
  });

  it('names both missing passwords and runs nothing', async () => {
    const fake = recordingSql();
    const error = await setRolePasswords(fake.sql, {}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: 'Invalid environment: FF_APP_PASSWORD (missing), FF_AUTH_PASSWORD (missing)',
    });
    expect(fake.texts).toHaveLength(0);
  });

  it('refuses short or spaced passwords without echoing them and runs nothing', async () => {
    const fake = recordingSql();
    const error = await setRolePasswords(fake.sql, {
      FF_APP_PASSWORD: 'short-secret-Q7',
      FF_AUTH_PASSWORD: `${'a'.repeat(31)} b`,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: 'Invalid environment: FF_APP_PASSWORD (malformed), FF_AUTH_PASSWORD (malformed)',
    });
    expect(inspect(error, { depth: 10 })).not.toContain('short-secret-Q7');
    expect(fake.texts).toHaveLength(0);
  });
});
