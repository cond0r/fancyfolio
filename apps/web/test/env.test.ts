import { inspect } from 'node:util';
import { parseEnv } from '@fancyfolio/contracts';
import { describe, expect, it } from 'vitest';
import { revalidateEnv } from '../env.ts';

const secret = 'revalidate-secret-0123456789abcdef-0123';

describe('revalidateEnv', () => {
  it('reads REVALIDATE_SECRET and names it when missing', () => {
    expect(parseEnv(revalidateEnv, { REVALIDATE_SECRET: secret, UNRELATED: 'x' })).toEqual({
      REVALIDATE_SECRET: secret,
    });
    expect(() => parseEnv(revalidateEnv, {})).toThrow(
      new Error('Invalid environment: REVALIDATE_SECRET (missing)'),
    );
  });

  it.each([
    'pw-secret-K3-too-short',
    'pw-secret-K3 with a space 0123456789abcdef',
    'pw-secret-K3-é-0123456789abcdef-0123',
  ])('refuses REVALIDATE_SECRET=%j as malformed without printing it', (value) => {
    let error: unknown;
    try {
      parseEnv(revalidateEnv, { REVALIDATE_SECRET: value });
    } catch (caught) {
      error = caught;
    }
    expect(error).toEqual(new Error('Invalid environment: REVALIDATE_SECRET (malformed)'));
    expect(inspect(error, { depth: 10 })).not.toContain('pw-secret-K3');
  });
});
