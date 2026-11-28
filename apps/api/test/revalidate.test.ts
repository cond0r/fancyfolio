import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { afterAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

type Answer = (res: ServerResponse) => void;

const secret = process.env.REVALIDATE_SECRET ?? '';
const tenant = 'tenant:3f6d2a9e-8b1c-4e7a-9d05-6c2b7e1f4a01';
const received: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] =
  [];
let answers: Answer[] = [];
let log: MockInstance;

const status =
  (code: number, headers = {}): Answer =>
  (res) =>
    res.writeHead(code, headers).end();
const hang: Answer = () => {};

const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  received.push({ method: req.method, url: req.url, headers: req.headers, body });
  (answers.shift() ?? status(500))(res);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const webUrl = `http://127.0.0.1:${Object(server.address()).port}`;

async function load(url: string) {
  vi.stubEnv('WEB_URL', url);
  vi.resetModules();
  return (await import('../src/lib/revalidate.ts')).revalidate;
}
const revalidate = await load(webUrl);

beforeEach(() => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => {
    received.length = 0;
    answers = [];
    vi.restoreAllMocks();
  };
});

afterAll(() => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  server.close();
});

const logged = () => log.mock.calls.map(([line]) => JSON.parse(String(line)));
const failed = (requestId: string, outcomes: string[]) => [
  { requestId, event: 'revalidate-failed', outcomes },
];

describe('revalidate', () => {
  it('posts the tags once, without duplicates, signed over "<t>.<body>", and answers true on 204', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_900);
    answers = [status(204)];
    expect(await revalidate([tenant, 'site:ines', tenant], 'req-1')).toBe(true);
    const body = JSON.stringify({ tags: [tenant, 'site:ines'] });
    const v1 = createHmac('sha256', secret).update(`1760000000.${body}`).digest('hex');
    const signature = `t=1760000000,v1=${v1}`;
    const headers = { 'content-type': 'application/json', 'x-fancyfolio-signature': signature };
    expect(received).toMatchObject([{ method: 'POST', url: '/revalidate', headers, body }]);
    expect(logged()).toEqual([]);
  });

  const redirect = status(308, { location: `${webUrl}/elsewhere` });
  it.each([
    ['a 503 then a 204', [status(503), status(204)], [], 0],
    ['a missing route', [status(404), status(404)], ['404', '404'], 0],
    ['a 200 that is not 204', [status(200), status(200)], ['200', '200'], 0],
    ['a redirect it never follows', [redirect, redirect], ['TypeError', 'TypeError'], 0],
    ['a web that never answers', [hang, hang], ['TimeoutError', 'TimeoutError'], 3900],
  ])('makes two attempts on %s', async (_, replies, outcomes, minMs) => {
    answers = replies;
    const started = performance.now();
    expect(await revalidate([tenant], 'req-2')).toBe(outcomes.length === 0);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(minMs);
    expect(elapsed).toBeLessThan(5500);
    expect(received.map((call) => call.url)).toEqual(['/revalidate', '/revalidate']);
    expect(logged()).toEqual(outcomes.length === 0 ? [] : failed('req-2', outcomes));
  });

  it('answers false when the web is unreachable', async () => {
    const unreachable = await load('http://127.0.0.1:1');
    expect(await unreachable([tenant], 'req-3')).toBe(false);
    expect(logged()).toEqual(failed('req-3', ['TypeError', 'TypeError']));
  });
});
