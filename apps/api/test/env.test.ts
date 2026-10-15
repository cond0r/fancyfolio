import { inspect } from 'node:util';
import { parseEnv } from '@fancyfolio/contracts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { localEnv } from '../src/env.ts';

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
