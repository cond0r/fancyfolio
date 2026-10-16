import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isChallengeToken,
  isHostname,
  isHttpsUrl,
  isLinkUrl,
  isSlug,
  LIMITS,
  withinFenceLimit,
} from '../src/index.ts';

const label63 = 'a'.repeat(63);

describe('isSlug', () => {
  it.each(['a', '1', 'billing-rewrite', 'v2-launch-notes', 'a-b-c', 'a'.repeat(64)])(
    'accepts %j',
    (value) => {
      expect(isSlug(value)).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['65 characters', 'a'.repeat(65)],
    ['leading hyphen', '-billing'],
    ['trailing hyphen', 'billing-'],
    ['double hyphen', 'billing--rewrite'],
    ['upper case', 'Billing'],
    ['underscore', 'billing_rewrite'],
    ['dot', 'billing.md'],
    ['slash', 'billing/rewrite'],
    ['parent path', '../billing'],
    ['encoded dot', '%2e%2e'],
    ['space', 'billing rewrite'],
    ['trailing newline', 'billing\n'],
    ['leading newline', '\nbilling'],
    ['e with acute', 'café'],
    ['Cyrillic a', 'billing-а'],
    ['fullwidth letters', 'ｂｉｌｌｉｎｇ'],
    ['quote and comment', "billing'--"],
    ['SQL fragment', "a'); drop table case_studies; --"],
  ])('refuses %s', (_name, value) => {
    expect(isSlug(value)).toBe(false);
  });
});

describe('isHostname', () => {
  it.each([
    'ines.example',
    'a.b',
    'www.ines.example',
    'ines-okafor.example',
    'xn--80ak6aa92e.example',
    'ines.xn--p1ai',
    '1password.example',
    `${label63}.example`,
    `${[label63, label63, label63, 'a'.repeat(58)].join('.')}.ab`,
  ])('accepts %j', (value) => {
    expect(isHostname(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['single label', 'localhost'],
    ['upper case', 'Ines.example'],
    ['trailing dot', 'ines.example.'],
    ['leading dot', '.ines.example'],
    ['empty label', 'ines..example'],
    ['label with leading hyphen', '-ines.example'],
    ['label with trailing hyphen', 'ines-.example'],
    ['64-character label', `${'a'.repeat(64)}.example`],
    ['254 characters', `${[label63, label63, label63, 'a'.repeat(59)].join('.')}.ab`],
    ['IPv4 literal', '127.0.0.1'],
    ['short IPv4 literal', '127.1'],
    ['hex IPv4 literal', '0x7f.1'],
    ['IPv6 literal', '[::1]'],
    ['numeric top-level label', 'ines.123'],
    ['wildcard', '*.vercel.app'],
    ['port', 'ines.example:443'],
    ['credentials', 'user@ines.example'],
    ['path', 'ines.example/x'],
    ['scheme', 'https://ines.example'],
    ['underscore', 'ines_okafor.example'],
    ['space', 'ines .example'],
    ['trailing newline', 'ines.example\n'],
    ['unicode', 'inés.example'],
    ['fullwidth dot', 'ines．example'],
    ['quote and comment', "ines.example'--"],
    ['LIKE wildcard', '%.example'],
  ])('refuses %s', (_name, value) => {
    expect(isHostname(value)).toBe(false);
  });
});

const site = 'https://ines.example';
const urlOf = (length: number) => `${site}/${'x'.repeat(length - site.length - 1)}`;

describe('isChallengeToken', () => {
  it.each([
    ['32 random bytes in base64url', randomBytes(32).toString('base64url')],
    ['43 characters', 'a'.repeat(43)],
    ['64 characters', '-_'.repeat(32)],
    [
      'every base64url character',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
    ],
  ])('accepts %s', (_name, value) => {
    expect(isChallengeToken(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['one character', 'a'],
    ['42 characters', 'a'.repeat(42)],
    ['65 characters', 'a'.repeat(65)],
    ['base64 padding', `${'a'.repeat(43)}=`],
    ['plus', `${'a'.repeat(42)}+`],
    ['slash', `${'a'.repeat(42)}/`],
    ['space', `${'a'.repeat(21)} ${'a'.repeat(21)}`],
    ['trailing newline', `${'a'.repeat(43)}\n`],
    ['leading newline', `\n${'a'.repeat(43)}`],
    ['e with acute', `${'a'.repeat(42)}é`],
    ['fullwidth letters', 'ａ'.repeat(43)],
    ['TXT record prefix', `fancyfolio-verify=${'a'.repeat(43)}`],
    ['quote and comment', `${'a'.repeat(43)}'; --`],
  ])('refuses %s', (_name, value) => {
    expect(isChallengeToken(value)).toBe(false);
  });
});

describe('isHttpsUrl and isLinkUrl', () => {
  it.each([
    ['a host', site],
    ['a path, query and fragment', `${site}/notes?tag=postgres#rls`],
    ['a percent-encoded path', `${site}/caf%C3%A9`],
    ['a punycode host', 'https://xn--ins-bpa.example/'],
    ['2048 characters', urlOf(LIMITS.url)],
  ])('accept an https URL with %s', (_name, value) => {
    expect(isHttpsUrl(value)).toBe(true);
    expect(isLinkUrl(value)).toBe(true);
  });

  it('accept a mailto URL only as a link', () => {
    expect(isLinkUrl('mailto:ines@example.test')).toBe(true);
    expect(isHttpsUrl('mailto:ines@example.test')).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['the bare scheme', 'https://'],
    ['the bare mailto scheme', 'mailto:'],
    ['http', 'http://ines.example'],
    ['upper-case scheme', 'HTTPS://ines.example'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,x'],
    ['protocol-relative', '//ines.example'],
    ['leading space', ` ${site}`],
    ['inner space', `${site}/a b`],
    ['tab', `${site}/\t`],
    ['trailing newline', `${site}\n`],
    ['delete character', `${site}/\u007f`],
    ['no-break space', `${site}/\u00a0`],
    ['line separator', `${site}/\u2028`],
    ['unicode host', 'https://inés.example'],
    ['fullwidth slash', 'https:／／ines.example'],
    ['2049 characters', urlOf(LIMITS.url + 1)],
  ])('refuse %s', (_name, value) => {
    expect(isHttpsUrl(value)).toBe(false);
    expect(isLinkUrl(value)).toBe(false);
  });
});

describe('withinFenceLimit', () => {
  it.each([
    ['no fence', 'plain text'],
    ['empty', ''],
    ['10 fences', ':::'.repeat(10)],
    ['10 fenced lines', ':::callout\n'.repeat(10)],
    ['32 colons', ':'.repeat(32)],
    ['two colons repeated', '::\n'.repeat(1_000)],
  ])('accepts %s', (_name, value) => {
    expect(withinFenceLimit(value)).toBe(true);
  });

  it.each([
    ['11 fences', ':::'.repeat(11)],
    ['11 fenced lines', ':::callout\n'.repeat(11)],
    ['33 colons', ':'.repeat(33)],
    ['four colons repeated', '::::'.repeat(9)],
  ])('refuses %s', (_name, value) => {
    expect(withinFenceLimit(value)).toBe(false);
  });
});

describe('LIMITS', () => {
  it('caps rows per tenant, markdown sizes and fences per markdown field', () => {
    expect(LIMITS).toMatchObject({
      markdownFences: 10,
      caseStudies: 200,
      experiences: 50,
      projects: 100,
      hostname: 253,
      challengeToken: 64,
      links: 10,
      linkLabel: 40,
      tags: 12,
      tag: 32,
      url: 2_048,
      bioMd: 10_000,
      summaryMd: 2_000,
      bodyMd: 20_000,
    });
  });
});
