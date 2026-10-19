import { healthResponse } from '@fancyfolio/contracts';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import * as v from 'valibot';

const probeCookie = {
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  path: '/api/health',
  maxAge: 60,
} as const;

function cookieNames(header: string | undefined): string[] {
  return (header ?? '')
    .split(';')
    .filter((pair) => pair.includes('='))
    .map((pair) => pair.slice(0, pair.indexOf('=')).trim())
    .filter((name) => name !== '');
}

export const health = new Hono().get('/', (c) => {
  setCookie(c, '__Secure-ff-probe-a', '1', probeCookie);
  setCookie(c, '__Secure-ff-probe-b', '1', probeCookie);
  return c.json(
    v.parse(healthResponse, {
      ok: true,
      headers: {
        'x-forwarded-for': c.req.header('x-forwarded-for') ?? null,
        'x-real-ip': c.req.header('x-real-ip') ?? null,
        'x-vercel-forwarded-for': c.req.header('x-vercel-forwarded-for') ?? null,
      },
      origin: c.req.header('origin') ?? null,
      cookieNames: cookieNames(c.req.header('cookie')),
    }),
  );
});
