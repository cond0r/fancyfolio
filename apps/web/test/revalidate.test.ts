import { createHmac } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/revalidate/route.ts';

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

const secret = process.env.REVALIDATE_SECRET ?? '';
const tenant = 'tenant:3f6d2a9e-8b1c-4e7a-9d05-6c2b7e1f4a01';
const now = () => Math.floor(Date.now() / 1000);
const tags = (...list: unknown[]) => JSON.stringify({ tags: list });
const sites = (count: number) => tags(...Array.from({ length: count }, (_, i) => `site:s-${i}`));
const padded = (bytes: number) => `{"tags":["site:ines"]${' '.repeat(bytes - 22)}}`;
const encode = (text: string) => new TextEncoder().encode(text);
const invalidUtf8 = new Uint8Array([...encode('{"tags":["site:ines'), 0xff, ...encode('"]}')]);
type Body = string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
const endless = () => {
  let chunks = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++chunks > 64) controller.error(new Error('read past the size cap'));
      else controller.enqueue(new Uint8Array(1024));
    },
  });
};

function sign(body: Body) {
  if (body instanceof ReadableStream) return null;
  const t = now();
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex')}`;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /revalidate', () => {
  it.each<[string, number, Body, (string | null)?, number?]>([
    ['three signed tags', 204, tags(tenant, 'site:ines', 'site:ines.example')],
    ['ten tags', 204, sites(10)],
    ['a body of exactly 2048 bytes', 204, padded(2048)],
    ['no signature', 401, tags(tenant), null],
    ['the signature of another body', 401, tags(tenant), sign(tags('site:ines'))],
    ['no tags', 400, tags()],
    ['eleven tags', 400, sites(11)],
    ['an upper-case tenant id', 400, tags(tenant.replace('3f6d', '3F6D'))],
    ['a tenant tag without a uuid', 400, tags('tenant:ines')],
    ['a tenant tag with a trailing newline', 400, tags(`${tenant}\n`)],
    ['an upper-case site key', 400, tags('site:INES')],
    ['a reserved subdomain', 400, tags('site:admin')],
    ['an empty site key', 400, tags('site:')],
    ['a site key with a path', 400, tags('site:ines/../x')],
    ['a site key with a wildcard', 400, tags('site:*')],
    ['an unknown tag kind', 400, tags('page:/sites/ines')],
    ['a tag with a leading space', 400, tags(' site:ines')],
    ['a tag that is not a string', 400, tags(7)],
    ['an extra key', 400, JSON.stringify({ tags: ['site:ines'], purge: true })],
    ['a __proto__ key', 400, '{"tags":["site:ines"],"__proto__":{"admin":true}}'],
    ['a body that is not an object', 400, JSON.stringify(['site:ines'])],
    ['a body that is not JSON', 400, 'tags=site:ines'],
    ['invalid UTF-8', 400, invalidUtf8],
    ['a signed body of 2049 bytes', 400, padded(2049)],
    ['an unsigned body of 2049 bytes', 400, padded(2049), null],
    ['an endless unsigned body without content-length', 400, endless()],
    ['a short signed body declaring content-length 4096', 400, tags(tenant), undefined, 4096],
  ])('answers %s with %i and an empty body', async (_, status, body, header = sign(body), size) => {
    const headers = new Headers(header === null ? {} : { 'x-fancyfolio-signature': header });
    if (size) headers.set('content-length', String(size));
    const init = { method: 'POST', headers, body, duplex: 'half' };
    const res = await POST(new Request('http://localhost/revalidate', init));
    expect(res.status).toBe(status);
    expect(await res.text()).toBe('');
    const expired = status === 204 ? JSON.parse(String(body)).tags : [];
    expect(vi.mocked(revalidateTag).mock.calls).toEqual(
      expired.map((tag: string) => [tag, { expire: 0 }]),
    );
  });
});
