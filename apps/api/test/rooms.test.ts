import { createServer } from 'node:net';
import { LIMITS } from '@fancyfolio/contracts';
import { createClient } from '@liveblocks/client';
import { Liveblocks, type LiveblocksError } from '@liveblocks/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLiveblocksDev } from '../../../tests/liveblocks-dev.ts';
import app from '../src/index.ts';

let stopDevServer = () => {};
let baseUrl: string;
const silent = createServer(() => {});
await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
const silentUrl = `http://127.0.0.1:${Object(silent.address()).port}`;

beforeAll(async () => {
  ({ baseUrl, stop: stopDevServer } = await startLiveblocksDev());
});

afterAll(() => {
  stopDevServer();
  silent.close();
});

beforeEach(() => {
  vi.stubEnv('LIVEBLOCKS_SECRET_KEY', 'sk_localdev');
  vi.stubEnv('LIVEBLOCKS_BASE_URL', baseUrl);
  return () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  };
});

type Route = 'auth' | 'seed';
const uuid = '0b6a2987-af42-4aa3-8c85-9c4972596ba1';
const newRoom = () => `playground:${crypto.randomUUID()}`;
const block = { type: 'paragraph', props: {}, parent: null, slot: null, position: 'a', fields: {} };
const seed = (text: string) => ({ version: text, blocks: { b1: { ...block, fields: { text } } } });
const bodyFor = (route: Route, room: unknown) =>
  route === 'auth' ? { room } : { room, seed: seed('v1') };
const failing = (url: string) => ({
  LIVEBLOCKS_SECRET_KEY: 'sk_leak-K9',
  LIVEBLOCKS_BASE_URL: url,
});

function post(route: Route, body: unknown) {
  return app.request(`/api/v1/rooms/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function expectRefused(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error, requestId: res.headers.get('x-request-id') });
}

const devRooms = () => new Liveblocks({ secret: 'sk_localdev', baseUrl });
const roomExists = (room: string) =>
  devRooms()
    .getRoom(room)
    .then(
      () => true,
      (error: LiveblocksError) => (error.status === 404 ? false : Promise.reject(error)),
    );

describe.each<Route>(['auth', 'seed'])('POST /api/v1/rooms/%s', (route) => {
  it.each([
    bodyFor(route, `case-study:${uuid}`),
    bodyFor(route, 'playground:not-a-uuid'),
    bodyFor(route, `playground:${uuid.toUpperCase()}`),
    bodyFor(route, `playground:${uuid}x`),
    bodyFor(route, ` playground:${uuid}`),
    bodyFor(route, `playground:${uuid}\n`),
    bodyFor(route, `playground:${uuid}/../other`),
    bodyFor(route, 42),
    { ...bodyFor(route, newRoom()), userId: 'admin' },
    {},
    '{"room":',
    '',
  ])('refuses %j as 400', async (body) => {
    await expectRefused(await post(route, body), 400, 'Bad request');
  });

  it('refuses a body over its cap as 413', async () => {
    const pad = route === 'auth' ? 'p'.repeat(8 * 1024) : '€'.repeat(LIMITS.roomSeed);
    const res = await post(route, { ...bodyFor(route, newRoom()), pad });
    await expectRefused(res, 413, 'Payload too large');
  });

  it.each([
    ['without a secret key', 404, { LIVEBLOCKS_SECRET_KEY: undefined }],
    ['in production', 404, { VERCEL_ENV: 'production' }],
    ['in preview', 200, { VERCEL_ENV: 'preview' }],
    ['with an unreachable provider', 500, failing('http://127.0.0.1:1')],
    ['with a provider that never answers', 500, failing(silentUrl)],
  ])('answers a playground room %s with %i', async (_, status, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const room = newRoom();
    const res = await post(route, bodyFor(route, room));
    expect(res.status).toBe(status);
    expect(log).toHaveBeenCalledTimes(status === 500 ? 1 : 0);
    expect(JSON.stringify([await res.text(), log.mock.calls])).not.toContain('sk_leak-K9');
    expect(await roomExists(room)).toBe(route === 'seed' && status === 200);
  });
});

it('hands out a room token that opens that room and no other', async () => {
  const [room, other] = [newRoom(), newRoom()];
  const { token } = await (await post('auth', { room })).json();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const client = createClient({ baseUrl, authEndpoint: async () => ({ token }) });
  const enter = async (id: string) => {
    const { room: entered, leave } = client.enterRoom(id, { initialPresence: {} });
    const outcome = await new Promise<string>((resolve) => {
      entered.subscribe('status', (status) => status === 'connected' && resolve(status));
      entered.subscribe('error', (error) => resolve(error.message));
    });
    leave();
    return outcome;
  };
  expect(await enter(room)).toBe('connected');
  expect(await enter(other)).toBe('You have no access to this room');
});

it('seeds a room once when two seeds race and keeps the first copy', async () => {
  const room = newRoom();
  const statuses = await Promise.all(
    ['v1', 'v2'].map(async (text) => (await post('seed', { room, seed: seed(text) })).status),
  );
  expect([...statuses].sort()).toEqual([200, 409]);
  const winner = statuses[0] === 200 ? 'v1' : 'v2';
  expect(await devRooms().getStorageDocument(room, 'json')).toEqual({
    version: winner,
    blocks: { b1: { ...block, fields: { text: [[winner]] } } },
  });
});

const withBlock = (patch: object) => ({ version: 'v1', blocks: { b1: { ...block, ...patch } } });
const marked = (attributes: object) => withBlock({ fields: { text: [['x', attributes]] } });

it('stores a marked seed as its text segments', async () => {
  const room = newRoom();
  const text = [
    ['bold ', { bold: true }],
    ['italic ', { italic: true }],
    ['strike ', { strike: true }],
    ['code ', { code: true }],
    ['marked ', { highlight: true, color: 'blue' }],
    ['link', { link: 'https://example.test/case' }],
    [' plain'],
  ];
  expect((await post('seed', { room, seed: withBlock({ fields: { text } }) })).status).toBe(200);
  expect(await devRooms().getStorageDocument(room, 'json')).toEqual(
    withBlock({ fields: { text } }),
  );
});

it.each([
  ['over the size cap', withBlock({ fields: { text: 'a'.repeat(LIMITS.roomSeed) } })],
  ['no version', { blocks: {} }],
  ['blocks as a list', { version: 'v1', blocks: [block] }],
  ['a block without props', withBlock({ props: undefined })],
  ['an extra block key', withBlock({ owner: 'admin' })],
  ['a field that is not text', withBlock({ fields: { text: 7 } })],
  ['props posing as live data', withBlock({ props: [{ liveblocksType: 'LiveMap' }] })],
  ['props nested past the stack', withBlock({ props: { nested: 'NESTED' } })],
  ['a javascript: link', marked({ link: 'javascript:alert(1)' })],
  ['a colour named __proto__', marked({ color: '__proto__' })],
  ['a colour off the palette', marked({ color: 'pink' })],
  ['a mark flag that is not true', marked({ bold: 'yes' })],
  ['an attribute that is no mark', marked({ style: 'color: red' })],
  ['an attribute keyed __proto__', marked(JSON.parse('{"__proto__":true}'))],
])('refuses a seed with %s as 400 and writes nothing', async (_, bad) => {
  const room = newRoom();
  const deep = `${'['.repeat(100_000)}0${']'.repeat(100_000)}`;
  const body = JSON.stringify({ room, seed: bad }).replace('"NESTED"', deep);
  await expectRefused(await post('seed', body), 400, 'Bad request');
  expect(await roomExists(room)).toBe(false);
});
