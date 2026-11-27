import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '../lib/signature.ts';

const secret = process.env.REVALIDATE_SECRET ?? '';
const now = 1_760_000_000;
const body = new TextEncoder().encode('{"tags":["tenant:3f6d2a9e-8b1c-4e7a-9d05-6c2b7e1f4a01"]}');
const changed = new Uint8Array(body);
changed[changed.length - 3] ^= 1;

const digest = (t: number | string, key = secret) =>
  createHmac('sha256', key).update(`${t}.`).update(body).digest('hex');
const sign = (t: number | string, key = secret) => `t=${t},v1=${digest(t, key)}`;

describe('verifySignature', () => {
  it.each([
    ['a correct signature', true, sign(now)],
    ['a timestamp 300 s old', true, sign(now - 300)],
    ['a timestamp 301 s old', false, sign(now - 301)],
    ['a timestamp 300 s ahead', true, sign(now + 300)],
    ['a timestamp 301 s ahead', false, sign(now + 301)],
    ['another secret', false, sign(now, `${secret}x`)],
    ['one flipped body byte', false, sign(now), changed],
    ['a moved timestamp', false, `t=${now + 1},v1=${digest(now)}`],
    ['no header', false, null],
    ['an empty header', false, ''],
    ['the fields swapped', false, `v1=${digest(now)},t=${now}`],
    ['upper-case hex', false, `t=${now},v1=${digest(now).toUpperCase()}`],
    ['a short digest', false, sign(now).slice(0, -1)],
    ['a long digest', false, `${sign(now)}0`],
    ['a space after the comma', false, sign(now).replace(',', ', ')],
    ['a trailing newline', false, `${sign(now)}\n`],
    ['a second digest', false, `${sign(now)},v1=${digest(now)}`],
    ['a non-numeric timestamp', false, sign('17600000x0')],
    ['an 11-digit timestamp', false, sign('17600000000')],
    ['a negative timestamp', false, sign(-now)],
  ])('accepts %s: %s', (_, accepted, header, bytes = body) => {
    expect(verifySignature(header, bytes, secret, now)).toBe(accepted);
  });
});
