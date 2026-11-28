import { type RoomSeed, roomSeed } from '@fancyfolio/contracts';
import { createEditor } from '@fancyfolio/editor';
import type {
  Block,
  BlockId,
  Doc,
  Editor,
  EditorOptions,
  EditorProps,
  Json,
  Mark,
  MarkType,
  OnSave,
  Presence,
  RemoteOp,
  Saving,
  Span,
  Version,
} from '@fancyfolio/editor/types';
import {
  LiveMap,
  LiveObject,
  LiveText,
  type Lson,
  type LsonObject,
  type Room,
  type StorageUpdate,
} from '@liveblocks/client';
import * as v from 'valibot';

type Parent = Extract<RemoteOp, { kind: 'insertBlock' }>['parent'];
type Place = { readonly parent: Parent; readonly position: string };
type Known = Place & { readonly type: string; readonly props: string };
type Read = Place & { readonly block: Block; readonly owner: string | null };
type Segment = readonly [string, { readonly [key: string]: unknown }?];
type Attributes = { [key: string]: string | boolean };
type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };
type Touched = Map<BlockId, Set<string>>;
type Cleared = { [key: string]: null };
type Collab = NonNullable<EditorProps['collab']>;
type Own = Omit<Presence, 'userId'>;

const ROOM_TIMEOUT_MS = 5_000;
const markTypes: readonly MarkType[] = [
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'highlight',
  'color',
];
const recordShape = roomSeed.pipe[0];
const offset = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const peerAt = v.pipe(
  v.strictObject({ blockId: v.string(), field: v.string(), from: offset, to: offset }),
  v.check(({ from, to }) => from <= to),
);
const low = 0x30;
const high = 0x7a;

function between(suffix: string, before = '', after?: string): string {
  let key = '';
  let bound = after;
  for (let i = 0; ; i += 1) {
    const a = i < before.length ? before.charCodeAt(i) : low;
    const b = bound !== undefined && i < bound.length ? bound.charCodeAt(i) : high + 1;
    if (b - a > 1) return `${key}${String.fromCharCode(Math.floor((a + b) / 2))}${suffix}`;
    key += String.fromCharCode(a);
    if (b > a) bound = undefined;
  }
}

function plain(value: Json): Plain {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
}

function keyOf(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(keyOf).join(',')}]`;
  const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${keyOf(item)}`).join(',')}}`;
}

function attributeOf(mark: Span & { readonly type: MarkType }): [string, string | true] | [] {
  const { type, href, color } = mark;
  if (type === 'link') return href !== undefined && color === undefined ? ['link', href] : [];
  if (type === 'color') return color !== undefined && href === undefined ? ['color', color] : [];
  return href === undefined && color === undefined ? [type, true] : [];
}

function segmentsOf(text: string, marks: readonly Mark[]): ([string] | [string, Attributes])[] {
  const cuts = [...new Set([0, text.length, ...marks.flatMap(({ from, to }) => [from, to])])]
    .filter((cut) => cut >= 0 && cut <= text.length)
    .toSorted((a, b) => a - b);
  return cuts.slice(1).map((to, i) => {
    const from = cuts[i] ?? 0;
    const covering = marks.filter((mark) => mark.from <= from && to <= mark.to);
    const attributes: Attributes = Object.fromEntries(
      covering.flatMap((mark) => {
        const attribute = attributeOf(mark);
        return attribute.length === 0 ? [] : [attribute];
      }),
    );
    const piece = text.slice(from, to);
    return Object.keys(attributes).length > 0 ? [piece, attributes] : [piece];
  });
}

function markOf(type: MarkType, value: unknown, from: number, to: number): Mark | undefined {
  if (type === 'link')
    return typeof value === 'string' ? { type, from, to, href: value } : undefined;
  if (type === 'color')
    return typeof value === 'string' ? { type, from, to, color: value } : undefined;
  return value === true ? { type, from, to } : undefined;
}

function marksOf(segments: readonly Segment[]): Mark[] {
  const marks: Mark[] = [];
  let at = 0;
  for (const [text, attributes = {}] of segments) {
    for (const type of markTypes) {
      const mark = markOf(type, attributes[type], at, at + text.length);
      const last = marks.findLast((each) => each.type === type);
      if (mark === undefined) continue;
      const joins = last?.to === at && last.href === mark.href && last.color === mark.color;
      if (last !== undefined && joins) marks[marks.indexOf(last)] = { ...last, to: mark.to };
      else marks.push(mark);
    }
    at += text.length;
  }
  return marks;
}

function textOf(segments: readonly Segment[]): string {
  return segments.map(([text]) => text).join('');
}

function readRecord(id: BlockId, record: Lson | undefined): Read | undefined {
  if (!(record instanceof LiveObject)) return undefined;
  const fields = record.get('fields');
  if (!(fields instanceof LiveMap) || [...fields.values()].some((t) => !(t instanceof LiveText))) {
    return undefined;
  }
  const parsed = v.safeParse(recordShape, { version: 'room', blocks: { [id]: record.toJSON() } });
  const read = parsed.success ? parsed.output.blocks[id] : undefined;
  if (read === undefined) return undefined;
  const texts = Object.entries(read.fields).map(([name, data]) => {
    const segments = typeof data === 'string' ? [[data] as const] : data;
    return [name, textOf(segments), marksOf(segments)] as const;
  });
  const marks = texts.flatMap(([name, , list]) => (list.length > 0 ? [[name, list]] : []));
  const block: Block = {
    id,
    type: read.type,
    props: read.props,
    fields: Object.fromEntries(texts.map(([name, text]) => [name, text])),
    ...(marks.length > 0 && { marks: Object.fromEntries(marks) }),
  };
  const parent =
    read.parent === null || read.slot === null ? null : { blockId: read.parent, slot: read.slot };
  return { block, parent, owner: read.parent, position: read.position };
}

const sameParent = (a: Parent, b: Parent) =>
  a === b || (a !== null && b !== null && a.blockId === b.blockId && a.slot === b.slot);

const before = (a: [string, BlockId], b: [string, BlockId]) =>
  a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

function peersOf(others: ReturnType<Room['getOthers']>, refused: Set<number>): Presence[] {
  return others.flatMap(({ connectionId, presence }) => {
    if (presence.at === undefined || presence.at === null) return [];
    const parsed = v.safeParse(peerAt, presence.at);
    if (!parsed.success) {
      if (!refused.has(connectionId)) {
        refused.add(connectionId);
        console.error(`Peer ${connectionId} sent a presence outside the schema`);
      }
      return [];
    }
    refused.delete(connectionId);
    return [{ userId: `Guest ${connectionId}`, ...parsed.output }];
  });
}

function blocksIn(root: LiveObject<LsonObject>): LiveMap<string, Lson> {
  const blocks = root.get('blocks');
  if (!(blocks instanceof LiveMap)) throw new Error('the room has no blocks');
  return blocks;
}

function readBlocks(root: LiveObject<LsonObject>, refused: Set<BlockId>): Map<BlockId, Read> {
  const reads = new Map<BlockId, Read>();
  for (const [id, record] of blocksIn(root)) {
    const read = readRecord(id, record);
    if (read !== undefined) {
      reads.set(id, read);
      refused.delete(id);
    } else if (!refused.has(id)) {
      refused.add(id);
      console.error(new RangeError(`room block ${id} is not a valid record`));
    }
  }
  return reads;
}

function placesOf(
  reads: ReadonlyMap<BlockId, Read>,
  gone: ReadonlyMap<BlockId, string>,
): Map<BlockId, Place> {
  const places = new Map<BlockId, Place>();
  for (const [id, read] of reads) {
    const owner = read.owner === null ? undefined : reads.get(read.owner);
    if (read.owner === null || (owner?.owner === null && read.parent !== null)) {
      places.set(id, read);
    } else {
      const lost = read.owner === null ? undefined : gone.get(read.owner);
      places.set(id, { parent: null, position: lost ?? read.position });
    }
  }
  return places;
}

function listed(places: ReadonlyMap<BlockId, Place>, parent: Parent, except?: BlockId) {
  return [...places]
    .filter(([id, place]) => id !== except && sameParent(place.parent, parent))
    .toSorted(([a, x], [b, y]) => (before([x.position, a], [y.position, b]) ? -1 : 1))
    .map(([id]) => id);
}

function docOf(reads: ReadonlyMap<BlockId, Read>, places: ReadonlyMap<BlockId, Place>): Doc {
  const ids = listed(places, null);
  const blocks = new Map<BlockId, Block>();
  for (const id of ids) {
    const block = reads.get(id)?.block;
    if (block === undefined) continue;
    const names = new Set(
      [...places.values()].flatMap(({ parent }) => (parent?.blockId === id ? [parent.slot] : [])),
    );
    const slots = Object.fromEntries(
      [...names].map((slot) => [slot, listed(places, { blockId: id, slot })]),
    );
    for (const child of Object.values(slots).flat()) {
      const read = reads.get(child);
      if (read !== undefined) blocks.set(child, read.block);
    }
    blocks.set(id, names.size > 0 ? { ...block, slots } : block);
  }
  return { ids, blocks, sources: new Map() };
}

export function seedOf(doc: Doc, version: Version): RoomSeed {
  const blocks: RoomSeed['blocks'] = {};
  const list = (ids: readonly BlockId[], parent: Parent) => {
    const width = String(ids.length).length;
    ids.forEach((id, index) => {
      const block = doc.blocks.get(id);
      if (block === undefined) throw new RangeError(`the doc lists a missing block ${id}`);
      const fields = Object.entries(block.fields).map(([name, text]) => [
        name,
        segmentsOf(text, block.marks?.[name] ?? []),
      ]);
      blocks[id] = {
        type: block.type,
        props: plain(block.props),
        parent: parent?.blockId ?? null,
        slot: parent?.slot ?? null,
        position: `${String(index).padStart(width, '0')}U`,
        fields: Object.fromEntries(fields),
      };
      for (const [slot, children] of Object.entries(block.slots ?? {})) {
        list(children, { blockId: id, slot });
      }
    });
  };
  list(doc.ids, null);
  return { version, blocks };
}

export function liveblocksAdapter(room: Room): Collab {
  const snapshot = room.getStorageSnapshot();
  if (snapshot === null) throw new Error('the room storage is not loaded');
  const root: LiveObject<LsonObject> = snapshot;
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
    String.fromCharCode(0x61 + (byte % 26)),
  ).join('');
  const known = new Map<BlockId, Known>();
  const gone = new Map<BlockId, string>();
  const refused = new Set<BlockId>();
  const texts = new Map<LiveText, { readonly blockId: BlockId; readonly field: string }>();
  let listener: (ops: readonly RemoteOp[]) => void = () => undefined;

  const recordOf = (id: BlockId) => {
    const record = blocksIn(root).get(id);
    if (!(record instanceof LiveObject)) throw new Error(`the room has no block ${id}`);
    return record;
  };
  const fieldsOf = (id: BlockId) => {
    const fields = recordOf(id).get('fields');
    if (!(fields instanceof LiveMap)) throw new Error(`block ${id} has no fields`);
    return fields;
  };
  const liveText = (id: BlockId, field: string) => {
    const text = fieldsOf(id).get(field);
    return text instanceof LiveText ? text : undefined;
  };
  const textAt = (id: BlockId, field: string) => {
    const text = liveText(id, field);
    if (text === undefined) throw new Error(`block ${id} has no field ${field}`);
    return text;
  };

  function rank(id: BlockId, place: Place): number {
    let index = 0;
    for (const [other, at] of known) {
      const earlier = before([at.position, other], [place.position, id]);
      if (other !== id && sameParent(at.parent, place.parent) && earlier) index += 1;
    }
    return index;
  }

  function relink() {
    texts.clear();
    for (const id of known.keys()) {
      for (const [field, text] of fieldsOf(id)) {
        if (text instanceof LiveText) texts.set(text, { blockId: id, field });
      }
    }
  }

  function track(): Doc {
    const reads = readBlocks(root, refused);
    const placed = placesOf(reads, gone);
    known.clear();
    for (const [id, read] of reads) {
      const place = placed.get(id) ?? read;
      known.set(id, { ...place, type: read.block.type, props: keyOf(read.block.props) });
    }
    relink();
    return docOf(reads, placed);
  }

  function joining(doc: Doc): RemoteOp[] {
    const insert = (id: BlockId, parent: Parent): RemoteOp[] => {
      const block = doc.blocks.get(id);
      if (block === undefined) return [];
      const lists = Object.entries(block.slots ?? {});
      const slots = Object.fromEntries(lists.map(([slot]) => [slot, []]));
      const emptied = block.slots === undefined ? block : { ...block, slots };
      const children = lists.flatMap(([slot, list]) =>
        list.toReversed().flatMap((child) => insert(child, { blockId: id, slot })),
      );
      return [{ kind: 'insertBlock', block: emptied, parent, index: 0 }, ...children];
    };
    return doc.ids.toReversed().flatMap((id) => insert(id, null));
  }

  function restructure(touched: Touched): RemoteOp[] {
    const now = readBlocks(root, refused);
    const removed = [...known].filter(([id]) => !now.has(id));
    for (const [id, was] of removed) gone.set(id, was.position);
    const wanted = placesOf(now, gone);
    const ops: RemoteOp[] = [];
    const fresh: [BlockId, Read][] = [];
    for (const [id, read] of now) {
      const was = known.get(id);
      if (was === undefined) {
        fresh.push([id, read]);
        continue;
      }
      const { type, props } = read.block;
      const json = keyOf(props);
      if (type !== was.type) {
        const had = new Set(
          [...texts.values()].filter((at) => at.blockId === id).map((at) => at.field),
        );
        ops.push({ kind: 'setType', blockId: id, type, props });
        for (const [field, text] of Object.entries(read.block.fields)) {
          if (!had.has(field) && text !== '') {
            ops.push({ kind: 'insertText', blockId: id, field, offset: 0, text });
          }
          touch(touched, id, field);
        }
      } else if (json !== was.props) ops.push({ kind: 'setProps', blockId: id, props });
      known.set(id, { ...was, type, props: json });
    }
    fresh.sort(([, a], [, b]) => Number(a.owner !== null) - Number(b.owner !== null));
    for (const [id, read] of fresh) {
      const place = wanted.get(id) ?? read;
      const block = read.block;
      ops.push({ kind: 'insertBlock', block, parent: place.parent, index: rank(id, place) });
      known.set(id, { ...place, type: block.type, props: keyOf(block.props) });
    }
    const repairs: [BlockId, Place][] = [];
    for (const [id, place] of wanted) {
      const was = known.get(id);
      if (
        was === undefined ||
        (sameParent(was.parent, place.parent) && was.position === place.position)
      ) {
        continue;
      }
      ops.push({ kind: 'moveBlock', blockId: id, parent: place.parent, index: rank(id, place) });
      known.set(id, { ...was, ...place });
      const read = now.get(id);
      if (read !== undefined && read.owner !== null && place.parent === null)
        repairs.push([id, place]);
    }
    for (const [id] of removed.toSorted(
      ([, a], [, b]) => Number(a.parent === null) - Number(b.parent === null),
    )) {
      ops.push({ kind: 'removeBlock', blockId: id });
      known.delete(id);
    }
    relink();
    if (repairs.length > 0) {
      queueMicrotask(() =>
        room.history.disable(() =>
          room.batch(() => {
            for (const [id, { position }] of repairs) {
              recordOf(id).update({ parent: null, slot: null, position });
            }
          }),
        ),
      );
    }
    return ops;
  }

  function touch(touched: Touched, blockId: BlockId, field: string) {
    const fields = touched.get(blockId) ?? new Set<string>();
    fields.add(field);
    touched.set(blockId, fields);
  }

  function remarks(touched: ReadonlyMap<BlockId, ReadonlySet<string>>): RemoteOp[] {
    return [...touched].flatMap(([blockId, fields]) =>
      known.has(blockId)
        ? [...fields].flatMap((field): RemoteOp[] => {
            const segments = liveText(blockId, field)?.toJSON() ?? [];
            const to = textOf(segments).length;
            if (to === 0) return [];
            const marks = marksOf(segments);
            return markTypes.map((mark) => ({
              kind: 'markText',
              blockId,
              field,
              mark,
              from: 0,
              to,
              spans: marks.filter((each) => each.type === mark).map(({ type: _, ...span }) => span),
            }));
          })
        : [],
    );
  }

  function received(updates: readonly StorageUpdate[]) {
    const incoming = updates.filter(
      ({ source }) => source.origin === 'remote' || source.via !== 'edit',
    );
    if (incoming.length === 0) return;
    const ops: RemoteOp[] = [];
    const touched = new Map<BlockId, Set<string>>();
    for (const update of incoming) {
      const at = update.type === 'LiveText' ? texts.get(update.node) : undefined;
      if (update.type !== 'LiveText' || at === undefined) continue;
      const { blockId, field } = at;
      for (const change of update.updates) {
        if (change.type === 'insert') {
          ops.push({ kind: 'insertText', blockId, field, offset: change.index, text: change.text });
        } else if (change.type === 'delete') {
          const { index, length } = change;
          ops.push({ kind: 'deleteText', blockId, field, from: index, to: index + length });
        }
      }
      touch(touched, blockId, field);
    }
    if (incoming.some((update) => update.type !== 'LiveText')) ops.push(...restructure(touched));
    listener([...ops, ...remarks(touched)]);
  }

  function format(text: LiveText, from: number, to: number, patch: Attributes | Cleared) {
    if (to > from) text.format(from, to - from, patch);
  }

  function paint(text: LiveText, from: number, to: number, mark: Span & { type: MarkType }) {
    const attribute = attributeOf(mark);
    if (attribute.length > 0) format(text, from, to, Object.fromEntries([attribute]));
  }

  function placeAt(id: BlockId, parent: Parent, index: number): Place {
    const list = listed(known, parent, id).map((each) => known.get(each)?.position);
    return { parent, position: between(suffix, list[index - 1], list[index]) };
  }

  function write(op: RemoteOp, touched: Touched, retyped: Touched) {
    if (op.kind === 'insertBlock') {
      const { block } = op;
      const place = placeAt(block.id, op.parent, op.index);
      const fields = Object.entries(block.fields).map(
        ([name, text]) =>
          [name, new LiveText(segmentsOf(text, block.marks?.[name] ?? []))] as const,
      );
      const record = new LiveObject<LsonObject>({
        type: block.type,
        props: plain(block.props),
        parent: place.parent?.blockId ?? null,
        slot: place.parent?.slot ?? null,
        position: place.position,
        fields: new LiveMap(fields),
      });
      blocksIn(root).set(block.id, record);
      known.set(block.id, { ...place, type: block.type, props: keyOf(block.props) });
      for (const [name] of fields) touch(touched, block.id, name);
      return;
    }
    const { blockId } = op;
    const was = known.get(blockId);
    if (was === undefined) throw new Error(`the room has no block ${blockId}`);
    switch (op.kind) {
      case 'insertText': {
        const text = textAt(blockId, op.field);
        text.insert(op.offset, op.text);
        for (const mark of op.marks ?? []) {
          paint(text, op.offset + mark.from, op.offset + mark.to, mark);
        }
        return touch(touched, blockId, op.field);
      }
      case 'deleteText':
        textAt(blockId, op.field).delete(op.from, op.to - op.from);
        return touch(touched, blockId, op.field);
      case 'markText': {
        retyped.get(blockId)?.add(op.field);
        const fields = fieldsOf(blockId);
        if (!fields.has(op.field) && retyped.has(blockId)) fields.set(op.field, new LiveText());
        const text = textAt(blockId, op.field);
        format(text, op.from, op.to, { [op.mark]: null });
        for (const span of op.spans) paint(text, span.from, span.to, { ...span, type: op.mark });
        return touch(touched, blockId, op.field);
      }
      case 'setType':
        recordOf(blockId).update({ type: op.type, props: plain(op.props) });
        known.set(blockId, { ...was, type: op.type, props: keyOf(op.props) });
        retyped.set(blockId, new Set());
        return;
      case 'setProps':
        recordOf(blockId).set('props', plain(op.props));
        known.set(blockId, { ...was, props: keyOf(op.props) });
        return;
      case 'removeBlock':
        blocksIn(root).delete(blockId);
        gone.set(blockId, was.position);
        known.delete(blockId);
        return;
      case 'moveBlock': {
        const place = placeAt(blockId, op.parent, op.index);
        const { parent, position } = place;
        recordOf(blockId).update({
          parent: parent?.blockId ?? null,
          slot: parent?.slot ?? null,
          position,
        });
        known.set(blockId, { ...was, ...place });
      }
    }
  }

  track();
  let unsubscribe = room.subscribe(root, received, { isDeep: true });

  return {
    send(ops) {
      const touched = new Map<BlockId, Set<string>>();
      const retyped = new Map<BlockId, Set<string>>();
      room.batch(() => {
        for (const op of ops) write(op, touched, retyped);
        for (const [blockId, names] of retyped) {
          const fields = fieldsOf(blockId);
          for (const name of [...fields.keys()]) if (!names.has(name)) fields.delete(name);
        }
      });
      relink();
      queueMicrotask(() => listener(remarks(touched)));
    },
    onRemote(apply) {
      unsubscribe();
      const doc = track();
      const stop = room.subscribe(root, received, { isDeep: true });
      unsubscribe = stop;
      listener = apply;
      apply(joining(doc));
      return () => {
        if (listener === apply) listener = () => undefined;
        stop();
      };
    },
    onPresence(apply) {
      let mine: Own | null = null;
      const refusedPeers = new Set<number>();
      const send = () => room.updatePresence({ at: mine });
      const stops = [
        room.subscribe('others', (others) => apply(peersOf(others, refusedPeers))),
        room.subscribe('storage-status', (status) => {
          if (status === 'synchronized') send();
        }),
      ];
      apply(peersOf(room.getOthers(), refusedPeers));
      return {
        publish(next) {
          mine = next;
          if (room.getStorageStatus() === 'synchronized') send();
        },
        stop() {
          for (const stop of stops) stop();
          mine = null;
          send();
        },
      };
    },
    undo() {
      if (!room.history.canUndo()) return false;
      room.history.undo();
      return true;
    },
    redo() {
      if (!room.history.canRedo()) return false;
      room.history.redo();
      return true;
    },
  };
}

type JoinOptions = Omit<EditorOptions, 'collab' | 'version' | 'onSave'> & {
  readonly seed: (request: { readonly room: string; readonly seed: RoomSeed }) => Promise<Response>;
  readonly onSave?: OnSave;
};

function bounded<T>(work: Promise<T>, what: string): Promise<T> {
  const signal = AbortSignal.timeout(ROOM_TIMEOUT_MS);
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error(`${what} timed out`)), {
        once: true,
      });
    }),
  ]);
}

function seeded(room: Room, root: LiveObject<LsonObject>): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (root.get('blocks') === undefined) return;
      unsubscribe();
      resolve();
    };
    const unsubscribe = room.subscribe(root, check, { isDeep: true });
    check();
  });
}

export async function connectRoom(
  room: Room,
  markdown: string,
  version: Version,
  { seed, onSave, ...editing }: JoinOptions,
): Promise<{ readonly collab: Collab } & Saving> {
  const { root } = await bounded(room.getStorage(), 'Room storage');
  if (root.get('blocks') === undefined) {
    const page = createEditor(markdown, editing).doc();
    const response = await seed({ room: room.id, seed: seedOf(page, version) });
    if (response.status !== 200 && response.status !== 409) {
      throw new Error(`Room seed refused: ${response.status}`);
    }
    room.reconnect();
    await bounded(seeded(room, root), 'Room seed');
  }
  const collab = liveblocksAdapter(room);
  const current = () => {
    const stored = root.get('version');
    if (typeof stored !== 'string') throw new Error('the room has no version');
    return stored;
  };
  if (onSave === undefined) return { collab };
  const saving: OnSave = async (text) => {
    const stored = await onSave(text, current());
    if (stored.ok)
      room.history.disable(() => room.batch(() => root.set('version', stored.version)));
    return stored;
  };
  return { collab, version: current(), onSave: saving };
}

export async function joinRoom(
  room: Room,
  markdown: string,
  version: Version,
  options: JoinOptions,
): Promise<Editor> {
  const { seed: _seed, onSave: _onSave, ...editing } = options;
  const joined = await connectRoom(room, markdown, version, options);
  return createEditor(
    { ids: [], blocks: new Map(), sources: new Map() },
    { ...editing, ...joined },
  );
}
