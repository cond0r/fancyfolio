import { readdirSync, readFileSync } from 'node:fs';
import { type Context, Hono } from 'hono';
import { generateSpecs } from 'hono-openapi';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.ts';
import { type Env, notFound, onError, pathParams, responds, shell } from '../src/shell.ts';

const secret = 'secret-draft-K4';
const profile = v.strictObject({
  displayName: v.string(),
  links: v.array(v.strictObject({ label: v.string(), url: v.string() })),
});
const stored = {
  displayName: 'Ines Okafor',
  links: [{ label: 'Site', url: 'https://ines.example' }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

function serve(handler: (c: Context<Env>) => Response | Promise<Response>) {
  return new Hono<Env>()
    .use(shell)
    .notFound(notFound)
    .onError(onError)
    .get(
      '/profiles/:id',
      responds(profile, 404),
      pathParams(v.strictObject({ id: v.literal('p1') })),
      handler,
    );
}

async function expectRefused(res: Response) {
  expect(res.status).toBe(500);
  const requestId = res.headers.get('x-request-id');
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: 'Internal error', requestId });
  expect(text).not.toContain(secret);
}

function loggedLine(log: { mock: { calls: unknown[][] } }) {
  expect(log).toHaveBeenCalledTimes(1);
  const line = String(log.mock.calls[0][0]);
  expect(line).not.toContain(secret);
  return JSON.parse(line);
}

describe('a route that responds with a contract', () => {
  it('passes a body that matches the contract unchanged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await serve((c) => c.json(stored)).request('/profiles/p1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual(stored);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['a top-level field outside the contract', { ...stored, draftNote: secret }],
    [
      'a nested field outside the contract',
      { ...stored, links: [{ label: 'Site', url: 'https://ines.example', token: secret }] },
    ],
    ['a missing field', { links: [], note: secret }],
    ['a field of the wrong type', { displayName: 7, links: [], note: secret }],
  ])('refuses %s with the generic 500 and logs no value', async (_, body) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await serve((c) => c.json(body)).request('/profiles/p1');
    await expectRefused(res);
    expect(loggedLine(log)).toMatchObject({
      method: 'GET',
      path: '/profiles/p1',
      error: 'ValiError',
    });
  });

  it('passes the 404 of a malformed path value', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await serve((c) => c.json(stored)).request('/profiles/p2');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'Not found',
      requestId: res.headers.get('x-request-id'),
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses an error body with a field beyond the error contract', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await serve((c) =>
      c.json({ error: 'Not found', requestId: c.get('requestId'), stack: secret }, 404),
    ).request('/profiles/p1');
    await expectRefused(res);
    expect(loggedLine(log)).toMatchObject({ error: 'ValiError' });
  });

  it.each([201, 409])('refuses status %i, which the contract does not list', async (status) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await serve((c) => c.json(stored, status as 201)).request('/profiles/p1');
    await expectRefused(res);
    expect(loggedLine(log)).toMatchObject({ error: 'Error' });
  });

  it('refuses a body that is not JSON', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await serve((c) => c.text(`displayName=${secret}`)).request('/profiles/p1');
    await expectRefused(res);
    expect(loggedLine(log)).toMatchObject({ error: 'SyntaxError' });
  });

  it('keeps a thrown error the generic 500 with one log line', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await serve(() => {
      throw new Error(secret);
    }).request('/profiles/p1');
    await expectRefused(res);
    expect(loggedLine(log)).toMatchObject({ error: 'Error' });
  });
});

type Documented = {
  paths: Record<string, Record<string, { responses: Record<string, JsonResponse> }>>;
};
type JsonResponse = { content: { 'application/json': { schema: object } } };

describe('every route the API serves', () => {
  it('declares a response contract for each status it can answer', async () => {
    const { paths } = (await generateSpecs(app, {
      defaultValidationErrorResponse: false,
    })) as unknown as Documented;
    const served = new Set(
      app.routes
        .filter((route) => route.method !== 'ALL')
        .map((route) => `${route.method} ${route.path.replace(/:(\w+)/g, '{$1}')}`),
    );
    expect([...served]).toEqual(
      expect.arrayContaining([
        'GET /api/health',
        'GET /api/v1/sites/{key}',
        'GET /api/v1/sites/{key}/case-studies/{slug}',
      ]),
    );
    const documented = Object.entries(paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, { responses }]) => ({
        route: `${method.toUpperCase()} ${path}`,
        responses,
      })),
    );
    expect(new Set(documented.map(({ route }) => route))).toEqual(served);
    for (const { route, responses } of documented) {
      expect(Object.keys(responses)).toEqual(
        route.includes('{') ? ['200', '404', '500'] : ['200', '500'],
      );
      for (const response of Object.values(responses)) {
        expect(response.content['application/json'].schema).toBeTypeOf('object');
      }
    }
  });

  it('describes responses only through the helper that also checks them', () => {
    const src = new URL('../src/', import.meta.url);
    const describing = readdirSync(src, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        /\bdescribe(Route|Response)\b/.test(readFileSync(new URL(file, src), 'utf8')),
      );
    expect(describing).toEqual(['shell.ts']);
  });
});
