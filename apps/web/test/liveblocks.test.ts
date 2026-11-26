import type { RoomSeed } from '@fancyfolio/contracts';
import { createEditor } from '@fancyfolio/editor';
import { components, convergence, errors, safeHref } from '@fancyfolio/editor/testing';
import type { Doc, OnSave } from '@fancyfolio/editor/types';
import { createClient, LiveMap, LiveObject, LiveText, type Room } from '@liveblocks/client';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { startLiveblocksDev } from '../../../tests/liveblocks-dev.ts';
import { joinRoom, liveblocksAdapter, seedOf } from '../collab/liveblocks.ts';

let baseUrl: string;
let stopDevServer = () => {};

beforeAll(async () => {
  ({ baseUrl, stop: stopDevServer } = await startLiveblocksDev());
});

afterAll(() => stopDevServer());

const newRoom = () => `playground:${crypto.randomUUID()}`;
const counter = (prefix: string) => {
  let next = 0;
  return () => `${prefix}${next++}`;
};

function rest(path: string, body: unknown) {
  return fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: { authorization: 'Bearer sk_localdev', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function seed({ room, seed }: { readonly room: string; readonly seed: RoomSeed }) {
  const blocks = Object.entries(seed.blocks).map(([id, block]) => {
    const fields = Object.entries(block.fields).map(([name, data]) => [
      name,
      { liveblocksType: 'LiveText', data },
    ]);
    const map = { liveblocksType: 'LiveMap', data: Object.fromEntries(fields) };
    return [id, { liveblocksType: 'LiveObject', data: { ...block, fields: map } }];
  });
  const blockMap = { liveblocksType: 'LiveMap', data: Object.fromEntries(blocks) };
  const data = { version: seed.version, blocks: blockMap };
  return rest(`/v2/rooms/${encodeURIComponent(room)}/storage`, {
    liveblocksType: 'LiveObject',
    data,
  });
}

const entered: Room[] = [];

function enter(id: string) {
  const client = createClient({ baseUrl, publicApiKey: 'pk_localdev', throttle: 16 });
  const { room, leave } = client.enterRoom(id, { initialPresence: {} });
  entered.push(room);
  onTestFinished(() => {
    entered.splice(entered.indexOf(room), 1);
    leave();
  });
  return room;
}

const options = (prefix: string, onSave?: OnSave) => ({
  now: () => 0,
  newId: counter(prefix),
  components,
  safeHref,
  seed,
  onSave,
});

const join = (id: string, prefix: string, markdown = '', onSave?: OnSave) =>
  joinRoom(enter(id), markdown, 'v1', options(prefix, onSave));

const pageOf = (markdown: string) =>
  createEditor(markdown, { now: () => 0, newId: counter('b'), components, safeHref }).doc();

async function openRoom(count: number, source: Doc) {
  const id = newRoom();
  await rest('/v2/rooms', { id, defaultAccesses: ['room:write'] });
  await seed({ room: id, seed: seedOf(source, 'v1') });
  const editors = await Promise.all(Array.from({ length: count }, (_, i) => join(id, `p${i}-`)));
  let joiners = 0;
  return {
    id,
    peers: editors.map((editor) => ({
      editor,
      deliver: () => new Promise<void>((resolve) => setImmediate(resolve)),
    })),
    settle: () =>
      vi.waitFor(
        () => expect(entered.map((room) => room.getStorageStatus())).not.toContain('synchronizing'),
        { timeout: 10_000, interval: 20 },
      ),
    joiner: () => join(id, `j${joiners++}-`),
    raw: async () => {
      const room = enter(id);
      await room.getStorage();
      return liveblocksAdapter(room);
    },
    close: () => undefined,
  };
}

convergence(openRoom, 8);

async function intrude(id: string, blockId?: string) {
  const room = enter(id);
  const { root } = await room.getStorage();
  const blocks = root.get('blocks');
  if (!(blocks instanceof LiveMap)) throw new Error('the room has no blocks');
  const record = blockId === undefined ? undefined : blocks.get(blockId);
  const fields = record instanceof LiveObject ? record.get('fields') : undefined;
  const text = fields instanceof LiveMap ? fields.get('text') : undefined;
  return { room, blocks, text: text instanceof LiveText ? text : undefined };
}

it('drops an invalid record with one console.error on every editor', async () => {
  const session = await openRoom(2, pageOf('Kept.\n'));
  errors.mockClear();
  const { room, blocks } = await intrude(session.id);
  const record = { type: 'paragraph', props: {}, parent: null, slot: null, position: '9' };
  room.batch(() => {
    blocks.set('plain', new LiveObject({ ...record, fields: new LiveMap([['text', 'not live']]) }));
    blocks.set('owned', new LiveObject({ ...record, owner: 'admin', fields: new LiveMap() }));
  });
  await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(4));
  const joiner = await session.joiner();
  expect(errors).toHaveBeenCalledTimes(6);
  for (const editor of [...session.peers.map((peer) => peer.editor), joiner]) {
    expect(editor.markdown()).toEqual({ ok: true, markdown: 'Kept.\n' });
  }
});

it('keeps the text and no mark of hostile attributes on every editor and joiner', async () => {
  const page = pageOf('Kept.\n');
  const [blockId = ''] = page.ids;
  const session = await openRoom(2, page);
  errors.mockClear();
  const { room, text } = await intrude(session.id, blockId);
  room.batch(() => {
    text?.insert(0, 'a', { bold: 'yes' });
    text?.insert(0, 'b', { link: 'javascript:alert(1)' });
    text?.insert(0, 'c', { color: 'pink' });
  });
  const joiner = await session.joiner();
  await vi.waitFor(() => {
    for (const editor of [...session.peers.map((peer) => peer.editor), joiner]) {
      expect(editor.doc().blocks.get(blockId)).toEqual({
        ...page.blocks.get(blockId),
        fields: { text: 'cbaKept.' },
      });
    }
  });
  expect(errors).not.toHaveBeenCalled();
});

it('starts two joiners of an empty room on the same blocks and reads the page marks', async () => {
  const id = newRoom();
  const markdown = '**Bold** and [a link](https://example.test/a).\n';
  const [a, b] = await Promise.all([join(id, 'a', markdown), join(id, 'b', markdown)]);
  expect(b.doc().blocks).toEqual(a.doc().blocks);
  const joiner = await join(id, 'j', markdown);
  expect(joiner.doc().blocks).toEqual(a.doc().blocks);
  expect(joiner.markdown()).toEqual({ ok: true, markdown });
});

it('saves with the room version and refuses a version issued outside the room', async () => {
  const id = newRoom();
  let current = 'v1';
  const sent: string[] = [];
  const onSave: OnSave = async (_markdown, version) => {
    sent.push(version);
    if (version !== current) return { ok: false, reason: 'stale' };
    current = `v${sent.length + 1}`;
    return { ok: true, version: current };
  };
  const [roomA, roomB] = [enter(id), enter(id)];
  const a = await joinRoom(roomA, 'Text.\n', 'v1', options('a', onSave));
  const b = await joinRoom(roomB, 'Text.\n', 'v1', options('b', onSave));
  const versionIn = (room: typeof roomA) => room.getStorageSnapshot()?.get('version');
  expect(await a.save()).toEqual({ ok: true, version: 'v2' });
  await vi.waitFor(() => expect(versionIn(roomB)).toBe('v2'));
  expect(await b.save()).toEqual({ ok: true, version: 'v3' });
  await vi.waitFor(() => expect(versionIn(roomA)).toBe('v3'));
  current = 'v9';
  expect(await a.save()).toEqual({ ok: false, reason: 'stale' });
  expect(sent).toEqual(['v1', 'v2', 'v3']);
});
