import { inspect } from 'node:util';
import { parseEnv } from '@fancyfolio/contracts';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseEnv, localEnv } from '../src/env.ts';

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
  ])('refuses DATABASE_URL=%j at import without printing it', async (url, message) => {
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('DATABASE_CA_CERT', undefined);
    const error: unknown = await import('../src/db.ts').then(
      () => 'imported',
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : '').toBe(message);
    expect(inspect(error, { depth: 10 })).not.toContain('pw-secret-K3');
  });

  it('hands app code a handle whose only member is withTenant', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://ff_app:pw-secret-K3@127.0.0.1:1/x');
    const { db } = await import('../src/db.ts');
    expect(Object.keys(db)).toEqual(['withTenant']);
  });
});
