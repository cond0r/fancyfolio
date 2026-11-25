import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  createHeaders,
  deleteBody,
  isCalendarDate,
  isVersionToken,
  itemParams,
  LIMITS,
  markdownText,
} from '../src/index.ts';

describe('isCalendarDate', () => {
  it.each(['2026-10-13', '2024-02-29', '1999-12-31', '1000-01-01', '2999-12-31'])(
    'accepts %j',
    (value) => {
      expect(isCalendarDate(value)).toBe(true);
    },
  );

  it.each([
    ['February 30', '2026-02-30'],
    ['February 29 of a common year', '2026-02-29'],
    ['April 31', '2026-04-31'],
    ['month 13', '2026-13-01'],
    ['month 0', '2026-00-10'],
    ['day 0', '2026-10-00'],
    ['year 0', '0000-01-01'],
    ['year 3000', '3000-01-01'],
    ['five-digit year', '20261-01-01'],
    ['no padding', '2026-1-5'],
    ['a time', '2026-10-13 10:00:00'],
    ['slashes', '2026/10/13'],
    ['trailing newline', '2026-10-13\n'],
    ['empty', ''],
    ['SQL', "2026-10-13'; drop table experiences; --"],
  ])('refuses %s', (_name, value) => {
    expect(isCalendarDate(value)).toBe(false);
  });
});

describe('isVersionToken', () => {
  it.each([
    '2026-10-13 10:00:00.123456+00',
    '2026-10-13 10:00:00+00',
    '2026-10-13 15:30:00.123456+05:30',
    '2026-10-13 05:00:00.5-05',
  ])('accepts the Postgres text %j', (value) => {
    expect(isVersionToken(value)).toBe(true);
  });

  it.each([
    ['seven fraction digits', '2026-10-13 10:00:00.1234567+00'],
    ['an ISO string from Date', '2026-10-13T10:00:00.123Z'],
    ['no offset', '2026-10-13 10:00:00.123456'],
    ['a plus decoded to a space', '2026-10-13 10:00:00.123456 00'],
    ['hour 24', '2026-10-13 24:00:00+00'],
    ['minute 60', '2026-10-13 10:60:00+00'],
    ['offset 16', '2026-10-13 10:00:00+16'],
    ['February 30', '2026-02-30 10:00:00+00'],
    ['epoch milliseconds', '1792058400123'],
    ['a word', 'yesterday'],
    ['empty', ''],
    ['SQL', "2026-10-13 10:00:00+00' or '1'='1"],
  ])('refuses %s', (_name, value) => {
    expect(isVersionToken(value)).toBe(false);
  });
});

describe('owner write schemas', () => {
  it('accept a uuid item id and refuse anything else', () => {
    const id = '0b6f4c1e-8a2d-4e5f-9a7b-3c2d1e0f9a8b';
    expect(v.is(itemParams, { id })).toBe(true);
    for (const bad of ['1', 'not-a-uuid', `${id} `, "1' or '1'='1", `${id}x`]) {
      expect(v.is(itemParams, { id: bad }), bad).toBe(false);
    }
    expect(v.is(itemParams, { id, extra: '1' })).toBe(false);
  });

  it('require a uuid idempotency key and ignore other headers', () => {
    const uuid = '5d1f0c3a-2b4e-4f6a-8c9d-0e1f2a3b4c5d';
    expect(v.is(createHeaders, { 'idempotency-key': uuid, cookie: 'a=b' })).toBe(true);
    expect(v.is(createHeaders, { cookie: 'a=b' })).toBe(false);
    expect(v.is(createHeaders, { 'idempotency-key': 'twice' })).toBe(false);
  });

  it('carry only a version token in a delete body', () => {
    const updatedAt = '2026-10-13 10:00:00.123456+00';
    expect(v.is(deleteBody, { updatedAt })).toBe(true);
    expect(v.is(deleteBody, { updatedAt: '2026-10-13T10:00:00.123Z' })).toBe(false);
    expect(v.is(deleteBody, { updatedAt, id: '1' })).toBe(false);
    expect(v.is(deleteBody, {})).toBe(false);
  });

  it('cap markdown by length and by ::: fences', () => {
    const md = markdownText(1_000);
    expect(v.is(md, ':::'.repeat(LIMITS.markdownFences))).toBe(true);
    expect(v.is(md, ':::'.repeat(LIMITS.markdownFences + 1))).toBe(false);
    expect(v.is(md, 'a'.repeat(1_001))).toBe(false);
  });
});
