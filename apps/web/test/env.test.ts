import { inspect } from 'node:util';
import { parseEnv } from '@fancyfolio/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webEnv } from '../env.ts';

const valid = { API_URL: 'http://127.0.0.1:3201', ROOT_DOMAIN: 'localhost' };

function refusal(source: Record<string, string | undefined>): Error {
  try {
    parseEnv(webEnv, source);
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected parseEnv to throw');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the web environment', () => {
  it('reads exactly API_URL and ROOT_DOMAIN', () => {
    expect(Object.keys(webEnv.entries)).toEqual(['API_URL', 'ROOT_DOMAIN']);
    expect(parseEnv(webEnv, { ...valid, DATABASE_URL: 'postgres://ignored' })).toEqual(valid);
    expect(
      parseEnv(webEnv, {
        API_URL: 'https://api-fancyfolio.vercel.app',
        ROOT_DOMAIN: 'fancyfolio.example.test',
      }),
    ).toEqual({
      API_URL: 'https://api-fancyfolio.vercel.app',
      ROOT_DOMAIN: 'fancyfolio.example.test',
    });
  });

  it.each([
    'http://localhost:3201',
    'http://127.0.0.1',
    'https://api.example.test',
    'https://api.example.test:1',
    'https://api.example.test:65535',
    'https://127.0.0.1:8443',
    `https://${'a'.repeat(63)}.example.test`,
  ])('accepts API_URL=%j', (value) => {
    expect(parseEnv(webEnv, { ...valid, API_URL: value }).API_URL).toBe(value);
  });

  it('accepts ROOT_DOMAIN labels of 63 characters', () => {
    const rootDomain = `${'a'.repeat(63)}.example.test`;
    expect(parseEnv(webEnv, { ...valid, ROOT_DOMAIN: rootDomain }).ROOT_DOMAIN).toBe(rootDomain);
  });

  it('names every missing variable', () => {
    expect(refusal({}).message).toBe(
      'Invalid environment: API_URL (missing), ROOT_DOMAIN (missing)',
    );
  });

  it.each([
    '',
    'localhost:3201',
    'ftp://127.0.0.1',
    'javascript:alert(1)',
    'http://127.0.0.1:3201/',
    'http://127.0.0.1:3201/api',
    'http://127.0.0.1:3201?x=1',
    'http://user:pw@127.0.0.1:3201',
    'HTTP://API.EXAMPLE.TEST',
    'http://127.0.0.1:3201 ',
    'http://api.example.test',
    'http://10.0.0.5:3201',
    'http://localhost.example.test',
    'http://127.0.0.1.example.test',
    'https://api.example.test:0',
    'https://api.example.test:65536',
    'https://api.example.test:99999',
    'https://api.example.test:03201',
    'https://api.example.test:',
    'https://..',
    'https://a..b',
    'https://.example.test',
    'https://example.test.',
    'https://-a.example.test',
    'https://a-.example.test',
    `https://${'a'.repeat(64)}.example.test`,
    `https://${`${'a'.repeat(63)}.`.repeat(4)}test`,
    'https://169.254.169.254',
    'https://10.0.0.5:3201',
    'https://999.999.999.999',
    'https://0x7f000001',
    'http://127.1:3201',
    'http://[::1]:3201',
    'https://[::1]',
    'https://user@api.example.test',
    'https://api.example.test#x',
    'https://api.example.test/',
  ])('refuses API_URL=%j as malformed', (value) => {
    expect(refusal({ ...valid, API_URL: value }).message).toBe(
      'Invalid environment: API_URL (malformed)',
    );
  });

  it.each([
    '',
    'localhost:3000',
    'Fancyfolio.example.test',
    '.example.test',
    'example.test.',
    'a..b',
    '*.example.test',
    '-a.example.test',
    'a(b).test',
    '.*',
    'https://example.test',
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`,
    `${'a'.repeat(64)}.example.test`,
    'a-.example.test',
  ])('refuses ROOT_DOMAIN=%j as malformed', (value) => {
    expect(refusal({ ...valid, ROOT_DOMAIN: value }).message).toBe(
      'Invalid environment: ROOT_DOMAIN (malformed)',
    );
  });

  it('never prints a refused value', () => {
    const error = refusal({
      API_URL: 'http://user:leaky-secret-W4@x',
      ROOT_DOMAIN: 'leaky-host-W5:1',
    });
    expect(error.message).toBe('Invalid environment: API_URL (malformed), ROOT_DOMAIN (malformed)');
    expect(inspect(error, { depth: 10 })).not.toMatch(/leaky-(secret|host)/);
  });

  it('validates process.env when the module is imported', async () => {
    vi.stubEnv('ROOT_DOMAIN', 'Not-Valid-Q8:3000');
    vi.resetModules();
    await expect(import('../env.ts')).rejects.toThrow(
      'Invalid environment: ROOT_DOMAIN (malformed)',
    );
  });
});
