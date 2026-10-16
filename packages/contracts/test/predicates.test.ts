import { describe, expect, it } from 'vitest';
import { isSubdomain, RESERVED_SUBDOMAINS, SUBDOMAIN_PATTERN } from '../src/index.ts';

describe('isSubdomain', () => {
  it.each(['ines', 'abc', '123', 'a-b', 'abc--d', 'northwind-labs', 'a'.repeat(32)])(
    'accepts %j',
    (value) => {
      expect(isSubdomain(value)).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['1 character', 'a'],
    ['2 characters', 'ab'],
    ['33 characters', 'a'.repeat(33)],
    ['leading hyphen', '-ines'],
    ['trailing hyphen', 'ines-'],
    ['upper case', 'Ines'],
    ['all upper case', 'INES'],
    ['punycode label', 'xn--80ak6aa92e'],
    ['hyphens in positions 3 and 4', 'ab--cd'],
    ['underscore', 'in_es'],
    ['dot', 'in.es'],
    ['space', 'in es'],
    ['trailing newline', 'ines\n'],
    ['leading newline', '\nines'],
    ['Cyrillic a', 'аdmin'],
    ['dotless i', 'ınes'],
    ['zero-width space', 'ines​'],
    ['fullwidth letters', 'ｉｎｅｓ'],
    ['n with tilde', 'iñes'],
    ['emoji', 'ines\u{1f600}'],
    ['percent-encoding', '%69nes'],
    ['quote and comment', "ines'--"],
    ['SQL fragment', "a'); drop table tenants; --"],
  ])('refuses %s', (_name, value) => {
    expect(isSubdomain(value)).toBe(false);
  });

  it.each([...RESERVED_SUBDOMAINS])('refuses the reserved name %s', (name) => {
    expect(isSubdomain(name)).toBe(false);
  });
});

describe('RESERVED_SUBDOMAINS', () => {
  it('holds only names the pattern would otherwise accept, sorted and unique', () => {
    const pattern = new RegExp(SUBDOMAIN_PATTERN);
    expect(RESERVED_SUBDOMAINS.filter((name) => !pattern.test(name))).toEqual([]);
    expect([...new Set(RESERVED_SUBDOMAINS)].sort()).toEqual(RESERVED_SUBDOMAINS);
  });

  it('includes the platform hosts and the names an impostor would want', () => {
    expect(RESERVED_SUBDOMAINS).toEqual(
      expect.arrayContaining(['admin', 'api', 'app', 'demo', 'login', 'mail', 'www']),
    );
  });
});
