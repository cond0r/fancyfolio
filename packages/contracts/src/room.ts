import * as v from 'valibot';
import { LIMITS } from './limits.ts';

export const roomId = v.pipe(
  v.string(),
  v.regex(/^playground:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  v.description('A playground room: playground: and a lower-case UUID'),
);

type RoomJson = null | boolean | number | string | RoomJson[] | { [key: string]: RoomJson };

function isRoomJson(value: unknown): value is RoomJson {
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) continue;
    if (typeof item !== 'object' || Object.hasOwn(item, 'liveblocksType')) return false;
    for (const child of Object.values(item)) pending.push(child);
  }
  return true;
}

function withinSeedLimit(seed: unknown): boolean {
  try {
    return JSON.stringify(seed).length <= LIMITS.roomSeed;
  } catch {
    // deep nesting overflows the stack of JSON.stringify
    return false;
  }
}

const name = v.pipe(v.string(), v.nonEmpty());

const roomBlock = v.strictObject({
  type: name,
  props: v.custom<RoomJson>(isRoomJson),
  parent: v.nullable(name),
  slot: v.nullable(name),
  position: name,
  fields: v.record(name, v.string()),
});

const roomBlocks = v.pipe(
  v.custom<object>((blocks) => !Array.isArray(blocks)),
  v.record(name, roomBlock),
);

export const roomSeed = v.pipe(
  v.strictObject({ version: name, blocks: roomBlocks }),
  v.check((seed) => withinSeedLimit(seed), `At most ${LIMITS.roomSeed} characters as JSON`),
);

export const roomAuthRequest = v.strictObject({ room: roomId });
export const roomSeedRequest = v.strictObject({ room: roomId, seed: roomSeed });
export const roomToken = v.strictObject({ token: v.string() });
export const roomSeeded = v.strictObject({ room: v.string() });

export type RoomSeed = v.InferOutput<typeof roomSeed>;
