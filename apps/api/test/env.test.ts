import { inspect } from 'node:util';
import { parseEnv } from '@fancyfolio/contracts';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiEnv, databaseEnv, localEnv } from '../src/env.ts';

const required = {
  AUTH_DATABASE_URL: 'postgres://ff_auth:pw@pooler.example.test:6543/postgres',
  BETTER_AUTH_SECRET: 'auth-secret-0123456789abcdef-0123456789',
  BETTER_AUTH_URL: 'https://app.example.test',
  CLIENT_IP_HEADER: 'x-real-ip',
};
const parsed = { ...required, SIGNUP_ALLOWLIST: [] };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected parseEnv to throw');
}

describe('parseEnv', () => {
  it('defaults PORT to 3001 and reads a valid PORT as a number', () => {
    expect(parseEnv(localEnv, {})).toEqual({ PORT: 3001 });
    expect(parseEnv(localEnv, { PORT: '8080', UNRELATED: 'x' })).toEqual({ PORT: 8080 });
    expect(parseEnv(localEnv, { PORT: '65535' })).toEqual({ PORT: 65535 });
  });

  it.each(['', 'abc', '0', '65536', '30.5', ' 3001', '-1', '0x10'])(
    'refuses PORT=%j as malformed',
    (value) => {
      expect(refusal(() => parseEnv(localEnv, { PORT: value })).message).toBe(
        'Invalid environment: PORT (malformed)',
      );
    },
  );

  it('refuses to start the API until every auth setting is set, naming each missing one', async () => {
    for (const name of Object.keys(required)) vi.stubEnv(name, undefined);
    await expect(import('../src/index.ts')).rejects.toThrow(
      new Error(
        'Invalid environment: AUTH_DATABASE_URL (missing), BETTER_AUTH_SECRET (missing), BETTER_AUTH_URL (missing), CLIENT_IP_HEADER (missing)',
      ),
    );
  });

  it.each([
    ['BETTER_AUTH_URL', 'https://app.example.test:8443'],
    ['BETTER_AUTH_URL', 'http://localhost:3200'],
    ['BETTER_AUTH_URL', 'http://127.0.0.1:3000'],
    ['CLIENT_IP_HEADER', 'x-forwarded-for'],
    ['CLIENT_IP_HEADER', 'x-vercel-forwarded-for'],
  ])('accepts %s=%j', (name, value) => {
    expect(parseEnv(apiEnv, { ...required, [name]: value })).toEqual({ ...parsed, [name]: value });
  });

  it.each([
    ['AUTH_DATABASE_URL', 'https://ff_auth:pw-secret-K3@db.example.test/x'],
    ['AUTH_DATABASE_URL', 'postgres://ff_auth:pw-secret-K3@db.example.test/x?sslmode=require'],
    ['BETTER_AUTH_SECRET', 'pw-secret-K3-too-short'],
    ['BETTER_AUTH_SECRET', 'pw-secret-K3 with a space 0123456789abcdef'],
    ['BETTER_AUTH_URL', 'http://app.example.test'],
    ['BETTER_AUTH_URL', 'https://app.example.test/'],
    ['BETTER_AUTH_URL', 'https://app.example.test/api/auth'],
    ['BETTER_AUTH_URL', 'https://App.example.test'],
    ['BETTER_AUTH_URL', 'https://user:pw-secret-K3@app.example.test'],
    ['BETTER_AUTH_URL', 'javascript:alert(1)'],
    ['CLIENT_IP_HEADER', 'X-Real-IP'],
    ['CLIENT_IP_HEADER', 'cf-connecting-ip'],
    ['SIGNUP_ALLOWLIST.1', 'ines@example.test,pw-secret-K3'],
  ])('refuses %s=%j as malformed without printing it', (name, value) => {
    const error = refusal(() =>
      parseEnv(apiEnv, { ...required, [name.replace(/\.\d+$/, '')]: value }),
    );
    expect(error.message).toBe(`Invalid environment: ${name} (malformed)`);
    expect(inspect(error, { depth: 10 })).not.toContain('pw-secret-K3');
  });

  it('refuses an http BETTER_AUTH_URL in production without printing it', () => {
    const production = { ...required, VERCEL_ENV: 'production' };
    expect(parseEnv(apiEnv, production).BETTER_AUTH_URL).toBe(required.BETTER_AUTH_URL);
    const error = refusal(() =>
      parseEnv(apiEnv, { ...production, BETTER_AUTH_URL: 'http://localhost:3200' }),
    );
    expect(error.message).toBe('Invalid environment: BETTER_AUTH_URL (malformed)');
    expect(inspect(error, { depth: 10 })).not.toContain('localhost');
  });

  it('reads SIGNUP_ALLOWLIST as trimmed lower-case emails, empty when unset', () => {
    expect(parseEnv(apiEnv, required)).toEqual(parsed);
    expect(parseEnv(apiEnv, { ...required, SIGNUP_ALLOWLIST: '' })).toEqual(parsed);
    expect(
      parseEnv(apiEnv, {
        ...required,
        SIGNUP_ALLOWLIST: ' Ines.Okafor@Example.test , kenji@example.test,',
      }).SIGNUP_ALLOWLIST,
    ).toEqual(['ines.okafor@example.test', 'kenji@example.test']);
  });

  it('refuses a SIGNUP_ALLOWLIST email over 254 characters', () => {
    const email = (length: number) => `${'x'.repeat(length - 13)}@example.test`;
    expect(() => parseEnv(apiEnv, { ...required, SIGNUP_ALLOWLIST: email(254) })).not.toThrow();
    expect(
      refusal(() => parseEnv(apiEnv, { ...required, SIGNUP_ALLOWLIST: email(255) })).message,
    ).toBe('Invalid environment: SIGNUP_ALLOWLIST.0 (malformed)');
  });

  it('names a missing required variable', () => {
    const schema = v.object({ API_TOKEN: v.string() });
    expect(refusal(() => parseEnv(schema, {})).message).toBe(
      'Invalid environment: API_TOKEN (missing)',
    );
  });

  it('names every invalid variable once, in schema order', () => {
    const schema = v.object({
      API_TOKEN: v.pipe(v.string(), v.minLength(8), v.regex(/^tok_/)),
      PORT: localEnv.entries.PORT,
    });
    expect(refusal(() => parseEnv(schema, { API_TOKEN: 'x', PORT: 'abc' })).message).toBe(
      'Invalid environment: API_TOKEN (malformed), PORT (malformed)',
    );
  });

  it('never prints the value of a malformed variable', () => {
    const schema = v.object({ API_TOKEN: v.pipe(v.string(), v.regex(/^tok_[a-z]{8}$/)) });
    const error = refusal(() => parseEnv(schema, { API_TOKEN: 'leaky-secret-Z9' }));
    expect(error.message).toBe('Invalid environment: API_TOKEN (malformed)');
    expect(inspect(error, { depth: 10 })).not.toContain('leaky-secret-Z9');
  });
});

describe('the database pool', () => {
  it('requires DATABASE_URL', () => {
    expect(refusal(() => parseEnv(databaseEnv, {})).message).toBe(
      'Invalid environment: DATABASE_URL (missing)',
    );
  });

  it.each([
    [undefined, 'Invalid environment: DATABASE_URL (missing)'],
    [
      'not a url pw-secret-K3',
      'Database URL must be postgres://user:password@host[:port]/database, nothing else',
    ],
    [
      'mysql://ff_app:pw-secret-K3@db.example.test/x',
      'Database URL must be postgres://user:password@host[:port]/database, nothing else',
    ],
    [
      'postgres://ff_app:pw-secret-K3@db.example.test/x?sslmode=disable',
      'Database URL must be postgres://user:password@host[:port]/database, nothing else',
    ],
    [
      'postgres://ff_app:pw-secret-K3@db.example.test:6543/x',
      'Invalid environment: DATABASE_CA_CERT (missing)',
    ],
  ])('refuses DATABASE_URL=%j on first use without printing it', async (url, message) => {
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('DATABASE_CA_CERT', undefined);
    const { db } = await import('../src/db.ts');
    const error: unknown = await db
      .withTenant({ kind: 'site', site: 'alice' }, async () => 0)
      .then(
        () => 'opened',
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : '').toBe(message);
    expect(inspect(error, { depth: 10 })).not.toContain('pw-secret-K3');
  });

  it('serves /api/health with no DATABASE_URL, as a preview deployment runs', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    const { default: app } = await import('../src/index.ts');
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
  });

  it('hands app code a handle whose only member is withTenant', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://ff_app:pw-secret-K3@127.0.0.1:1/x');
    const { db } = await import('../src/db.ts');
    expect(Object.keys(db)).toEqual(['withTenant']);
  });
});
