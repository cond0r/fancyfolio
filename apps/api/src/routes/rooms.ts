import {
  isLinkUrl,
  parseEnv,
  type RoomSeed,
  roomAuthRequest,
  roomSeeded,
  roomSeedRequest,
  roomToken,
} from '@fancyfolio/contracts';
import { isColor } from '@fancyfolio/editor/colors';
import { Liveblocks, LiveblocksError, type PlainLsonObject } from '@liveblocks/node';
import { Hono } from 'hono';
import * as v from 'valibot';
import { liveblocksEnv } from '../env.ts';
import { type Env, jsonBody, notFound, refuse, responds } from '../shell.ts';

const PROVIDER_TIMEOUT_MS = 5_000;

function playgroundRooms(): Liveblocks | undefined {
  const env = parseEnv(liveblocksEnv, process.env);
  if (env.LIVEBLOCKS_SECRET_KEY === undefined || env.VERCEL_ENV === 'production') return undefined;
  return new Liveblocks({ secret: env.LIVEBLOCKS_SECRET_KEY, baseUrl: env.LIVEBLOCKS_BASE_URL });
}

function bounded<T>(call: (options: { signal: AbortSignal }) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return Promise.race([call({ signal }), timedOut]);
}

const flags = ['bold', 'italic', 'strike', 'code', 'highlight'];

function isMark([key, value]: [string, unknown]): boolean {
  if (key === 'link') return typeof value === 'string' && isLinkUrl(value);
  if (key === 'color') return isColor(value);
  return flags.includes(key) && value === true;
}

const markedSeedRequest = v.pipe(
  roomSeedRequest,
  v.check(({ seed }) =>
    Object.values(seed.blocks).every((block) =>
      Object.values(block.fields).every(
        (field) =>
          typeof field === 'string' ||
          field.every(([, marks = {}]) => Object.entries(marks).every(isMark)),
      ),
    ),
  ),
);

type Plain = PlainLsonObject['data'][string];

function storage(seed: RoomSeed): PlainLsonObject {
  const blocks = Object.entries(seed.blocks).map(([id, block]): [string, Plain] => {
    const fields = Object.entries(block.fields).map(([name, text]): [string, Plain] => [
      name,
      { liveblocksType: 'LiveText', data: typeof text === 'string' ? [[text]] : text },
    ]);
    const map: Plain = { liveblocksType: 'LiveMap', data: Object.fromEntries(fields) };
    return [id, { liveblocksType: 'LiveObject', data: { ...block, fields: map } }];
  });
  return {
    liveblocksType: 'LiveObject',
    data: {
      version: seed.version,
      blocks: { liveblocksType: 'LiveMap', data: Object.fromEntries(blocks) },
    },
  };
}

export const rooms = new Hono<Env>()
  .post('/auth', responds(roomToken, 400, 404), jsonBody(roomAuthRequest), async (c) => {
    const liveblocks = playgroundRooms();
    if (liveblocks === undefined) return notFound(c);
    const session = liveblocks.prepareSession(crypto.randomUUID());
    session.allow(c.req.valid('json').room, ['*:write']);
    const { status, body, error } = await bounded(() => session.authorize());
    if (status !== 200) throw new Error('Room access token refused', { cause: error });
    return c.json(v.parse(roomToken, JSON.parse(body)));
  })
  .post('/seed', responds(roomSeeded, 400, 404, 409), jsonBody(markedSeedRequest), async (c) => {
    const liveblocks = playgroundRooms();
    if (liveblocks === undefined) return notFound(c);
    const { room, seed } = c.req.valid('json');
    await bounded((options) => liveblocks.getOrCreateRoom(room, { defaultAccesses: [] }, options));
    const seeded = await bounded((options) =>
      liveblocks.initializeStorageDocument(room, storage(seed), options),
    ).then(
      () => true,
      (error: unknown) => {
        if (error instanceof LiveblocksError && error.status === 409) return false;
        throw error;
      },
    );
    return seeded ? c.json({ room }) : refuse(c, 409);
  });
