import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipGuard } from '../src/middleware/ip-guard.ts';
import { type Env, shell } from '../src/shell.ts';

const guarded = new Hono<Env>()
  .use(shell)
  .use(ipGuard)
  .get('/', (c) => c.text('through'));

afterEach(() => {
  vi.restoreAllMocks();
});

function request(headers: [string, string][]) {
  return guarded.request('/', { headers: new Headers(headers) });
}

describe('the client IP guard', () => {
  it.each(['203.0.113.7', '2001:db8::1', '::ffff:203.0.113.7'])(
    'lets a request through when x-forwarded-for holds exactly one IP (%s)',
    async (ip) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request([['x-forwarded-for', ip]]);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('through');
      expect(log).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['no header at all', []],
    ['an empty header', [['x-forwarded-for', '']]],
    ['a blank header', [['x-forwarded-for', ' ,  ']]],
    ['two IPs in one header', [['x-forwarded-for', '203.0.113.7, 198.51.100.9']]],
    [
      'the header sent twice',
      [
        ['x-forwarded-for', '203.0.113.7'],
        ['x-forwarded-for', '198.51.100.9'],
      ],
    ],
    ['a value that is not an IP', [['x-forwarded-for', 'unknown']]],
    ['an IP with a port', [['x-forwarded-for', '203.0.113.7:443']]],
    ['an out-of-range IPv4', [['x-forwarded-for', '203.0.113.256']]],
    ['markup', [['x-forwarded-for', '<script>alert(1)</script>']]],
    ['only another forwarding header', [['x-real-ip', '203.0.113.7']]],
  ] as [string, [string, string][]][])(
    'answers 503 for %s and logs no value',
    async (_, headers) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(headers);
      expect(res.status).toBe(503);
      const requestId = res.headers.get('x-request-id');
      expect(await res.json()).toEqual({ error: 'Service unavailable', requestId });
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0][0]);
      expect(JSON.parse(line)).toEqual({
        requestId,
        error: 'ClientIpUnresolved',
        header: 'x-forwarded-for',
      });
      for (const [, value] of headers) if (value.trim() !== '') expect(line).not.toContain(value);
    },
  );
});
