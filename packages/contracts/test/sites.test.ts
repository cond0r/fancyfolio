import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  caseStudy,
  caseStudySlug,
  errorBody,
  LIMITS,
  type SiteBundle,
  siteBundle,
  siteKey,
} from '../src/index.ts';

const hostile: [string, string][] = [
  ['empty', ''],
  ['upper case', 'Ines'],
  ['trailing dot', 'ines.example.'],
  ['port', 'ines.example:443'],
  ['parent path', '../ines'],
  ['encoded traversal', '%2e%2e%2fines'],
  ['slash', 'ines/case-studies'],
  ['space', 'ines example'],
  ['trailing newline', 'ines\n'],
  ['CRLF header', 'ines\r\nSet-Cookie: a=b'],
  ['null byte', 'ines\u0000'],
  ['quote and comment', "ines'--"],
  ['SQL fragment', "' OR '1'='1"],
  ['SQL statement', "ines'; drop table tenants; --"],
  ['Cyrillic i', 'іnes'],
  ['fullwidth letters', 'ｉｎｅｓ'],
  ['10 KB string', 'a'.repeat(10_240)],
  ['prototype key', '__proto__'],
  ['IPv4 literal', '127.0.0.1'],
  ['IPv6 literal', '[::1]'],
];

describe('siteKey', () => {
  it.each(['ines', 'abc', 'northwind-labs', 'ines.example', 'portfolio.ines.example'])(
    'accepts %j',
    (value) => {
      expect(v.is(siteKey, value)).toBe(true);
    },
  );

  it.each([
    ...hostile,
    ['reserved admin', 'admin'],
    ['reserved www', 'www'],
    ['ACE label', 'xn--ines'],
  ])('refuses %s', (_name, value) => {
    expect(v.is(siteKey, value)).toBe(false);
  });
});

describe('caseStudySlug', () => {
  it.each(['billing-rewrite', 'a', 'v2'])('accepts %j', (value) => {
    expect(v.is(caseStudySlug, value)).toBe(true);
  });

  it.each([...hostile, ['dot', 'billing.md'], ['65 characters', 'a'.repeat(65)]])(
    'refuses %s',
    (_name, value) => {
      expect(v.is(caseStudySlug, value)).toBe(false);
    },
  );
});

function over(limit: number): string {
  return 'x'.repeat(limit + 1);
}

const card = {
  slug: over(LIMITS.slug),
  title: over(LIMITS.title),
  summary: over(LIMITS.summary),
  coverUrl: over(LIMITS.url),
  experienceId: 'not-a-uuid',
  publishedAt: '2026-10-12 09:30:00.123456+00',
  updatedAt: '2026-10-12 09:30:00.123456+00',
};

const oversized: SiteBundle = {
  tenantId: 'not-a-uuid',
  subdomain: over(32),
  domain: over(LIMITS.hostname),
  profile: {
    displayName: over(LIMITS.displayName),
    headline: over(LIMITS.headline),
    location: over(LIMITS.location),
    bioMd: over(LIMITS.bioMd),
    avatarUrl: over(LIMITS.url),
    links: [{ label: over(LIMITS.linkLabel), url: over(LIMITS.url) }],
  },
  experiences: Array.from({ length: LIMITS.experiences + 1 }, () => ({
    id: 'e',
    company: over(LIMITS.company),
    role: over(LIMITS.role),
    location: over(LIMITS.location),
    startsOn: '2020-01-01',
    endsOn: null,
    summaryMd: ':::'.repeat(LIMITS.markdownFences + 1),
  })),
  projects: [
    {
      id: 'p',
      name: over(LIMITS.projectName),
      description: over(LIMITS.description),
      url: null,
      repoUrl: over(LIMITS.url),
      tags: Array.from({ length: LIMITS.tags + 1 }, () => over(LIMITS.tag)),
    },
  ],
  caseStudies: Array.from({ length: LIMITS.caseStudies + 1 }, () => card),
};

describe('the public response contracts', () => {
  it('carry no input limit, so a stored value longer than today’s limit still reads', () => {
    expect(v.parse(siteBundle, oversized)).toEqual(oversized);
    const body = { ...card, bodyMd: over(LIMITS.bodyMd) };
    expect(v.parse(caseStudy, body)).toEqual(body);
  });

  it.each([
    ['an unknown top-level field', { ...oversized, ownerId: 'u1' }],
    ['an unknown profile field', { ...oversized, profile: { ...oversized.profile, email: 'x' } }],
    ['a draft card', { ...oversized, caseStudies: [{ ...card, publishedAt: null }] }],
    ['a card with a body', { ...oversized, caseStudies: [{ ...card, bodyMd: 'draft' }] }],
  ])('refuse %s', (_name, value) => {
    expect(v.is(siteBundle, value)).toBe(false);
  });

  it('refuse a draft case study', () => {
    expect(v.is(caseStudy, { ...card, bodyMd: '', publishedAt: null })).toBe(false);
  });
});

describe('errorBody', () => {
  it('holds a message and a request id, nothing else', () => {
    expect(v.is(errorBody, { error: 'Not found', requestId: 'r1' })).toBe(true);
    expect(v.is(errorBody, { error: 'Internal error', requestId: 'r1', stack: 'at x' })).toBe(
      false,
    );
  });
});
