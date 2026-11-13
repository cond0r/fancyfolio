import { load, save } from '../src/core/markdown.ts';
import { sameJson } from '../src/core/model.ts';
import { mapIn, plan } from '../src/core/ops.ts';
import { registryOf } from '../src/core/registry.ts';
import type { AnyComponent, CollabAdapter, Doc, Op, Parent, RemoteOp } from '../src/core/types.ts';
import { counter } from './generate.ts';

type Entry = { readonly client: number; readonly op: RemoteOp; readonly at: string };
type Message = { readonly client: number; readonly entries: readonly Entry[] };
type Registry = ReturnType<typeof registryOf>;
type Replica = { doc: Doc; readonly positions: Map<string, string>; readonly registry: Registry };
export type Room = ReturnType<typeof room>;

function applied(doc: Doc, op: Op, registry: Registry): { doc: Doc; inverse: Op } {
  const { change, inverse } = plan(doc, op, registry, true);
  const blocks = new Map(doc.blocks);
  for (const id of change.drop) blocks.delete(id);
  for (const block of change.put) blocks.set(block.id, block);
  return { doc: { ids: change.ids ?? doc.ids, blocks, sources: doc.sources }, inverse };
}

function through(a: Entry, b: Entry, registry: Registry): Entry[] {
  const { op } = a;
  if (op.kind !== 'insertText' && op.kind !== 'deleteText') return [a];
  const { blockId, field } = op;
  if (b.op.kind === 'setType' && a.client !== b.client) {
    return mapIn(registry, b.op, { blockId, field, offset: 0 }) === undefined ? [] : [a];
  }
  if (b.op.kind !== 'insertText' && b.op.kind !== 'deleteText') return [a];
  const map = (offset: number, bias: -1 | 1) =>
    mapIn(registry, b.op, { blockId, field, offset }, bias)?.offset ?? offset;
  if (op.kind === 'insertText') {
    return [{ ...a, op: { ...op, offset: map(op.offset, a.client > b.client ? 1 : -1) } }];
  }
  const cut = (from: number, to: number) => ({ ...a, op: { ...op, from, to } });
  const [from, to] = [map(op.from, 1), map(op.to, -1)];
  if (b.op.kind === 'insertText' && to - from > op.to - op.from) {
    return [cut(b.op.offset + b.op.text.length, to), cut(from, b.op.offset)];
  }
  return from < to ? [cut(from, to)] : [];
}

function cross(as: readonly Entry[], bs: readonly Entry[], registry: Registry): [Entry[], Entry[]] {
  const [a, ...moreA] = as;
  const [b, ...moreB] = bs;
  if (a === undefined || b === undefined) return [[...as], [...bs]];
  if (moreA.length > 0) {
    const [a1, b1] = cross([a], bs, registry);
    const [a2, b2] = cross(moreA, b1, registry);
    return [[...a1, ...a2], b2];
  }
  if (moreB.length > 0) {
    const [a1, b1] = cross(as, [b], registry);
    const [a2, b2] = cross(a1, moreB, registry);
    return [a2, [...b1, ...b2]];
  }
  return [through(a, b, registry), through(b, a, registry)];
}

function positionOf({ positions }: Replica, id: string): string {
  const position = positions.get(id);
  if (position === undefined) throw new Error(`block ${id} has no position`);
  return position;
}

function listOf({ doc }: Replica, parent: Parent): readonly string[] {
  return parent === null ? doc.ids : (doc.blocks.get(parent.blockId)?.slots?.[parent.slot] ?? []);
}

function rank(replica: Replica, parent: Parent, id: string): number {
  const at = positionOf(replica, id);
  return listOf(replica, parent).filter((other) => {
    const position = positionOf(replica, other);
    return other !== id && (position < at || (position === at && other < id));
  }).length;
}

function key(before = '', after: string | undefined, client: number): string {
  if (after !== undefined && before >= after) throw new Error('no position between two blocks');
  let prefix = '';
  for (let i = 0, bounded = after !== undefined; ; i += 1) {
    const low = Number(before[i] ?? 0);
    const high = bounded ? Number(after?.[i] ?? 0) : 10;
    if (high - low > 1) return `${prefix}${Math.floor((low + high) / 2)}${client + 1}`;
    bounded &&= high === low;
    prefix += low;
  }
}

function absorb(replica: Replica, { op, at }: Entry): RemoteOp[] {
  const out: RemoteOp[] = [];
  const put = (each: RemoteOp) => {
    replica.doc = applied(replica.doc, each, replica.registry).doc;
    out.push(each);
  };
  const block = 'blockId' in op ? replica.doc.blocks.get(op.blockId) : undefined;
  if (op.kind === 'insertText' || op.kind === 'deleteText') {
    if (block === undefined) out.push(op);
    else put(op);
  } else if (op.kind === 'insertBlock' || op.kind === 'moveBlock') {
    const id = op.kind === 'insertBlock' ? op.block.id : op.blockId;
    if (op.kind === 'moveBlock' && block === undefined) return out;
    const owner = op.parent?.blockId;
    const lost = owner !== undefined && !replica.doc.blocks.has(owner);
    replica.positions.set(id, lost ? positionOf(replica, owner) : at);
    const parent = lost ? null : op.parent;
    put({ ...op, parent, index: rank(replica, parent, id) });
  } else if (op.kind === 'removeBlock') {
    if (block === undefined) return out;
    for (const child of Object.values(block.slots ?? {}).flat()) {
      replica.positions.set(child, positionOf(replica, op.blockId));
      put({ kind: 'moveBlock', blockId: child, parent: null, index: rank(replica, null, child) });
    }
    put(op);
  } else if (block !== undefined) {
    const type = op.kind === 'setType' ? op.type : block.type;
    if (type !== block.type || !sameJson(op.props, block.props)) put(op);
  }
  return out;
}

function replicaOf(source: string | Doc, registry: Registry): Replica {
  const loaded = typeof source === 'string' ? load(source, counter(), registry) : source;
  const doc = { ...loaded, sources: new Map() };
  const slots = [...doc.blocks.values()].flatMap((block) => Object.values(block.slots ?? {}));
  const ranked = [doc.ids, ...slots].flatMap((ids) =>
    ids.map((id, i) => [id, `${1e4 + i}1`] as const),
  );
  return { doc, positions: new Map(ranked), registry };
}

export function room(source: string | Doc, components: readonly AnyComponent[]) {
  const registry = registryOf(components);
  const replica = replicaOf(source, registry);
  const log: Entry[] = [];
  const inboxes: Message[][] = [];
  return {
    inboxes,
    replica: () => replicaOf(source, registry),
    receive(client: number, seen: number, entries: readonly Entry[]) {
      const [mapped] = cross(entries, log.slice(seen), registry);
      log.push(...mapped);
      for (const entry of mapped) absorb(replica, entry);
      for (const inbox of inboxes) inbox.push({ client, entries: mapped });
    },
    markdown: () => save(replica.doc, registry),
  };
}

const written = ({ op }: Entry): string =>
  op.kind === 'setType' || op.kind === 'moveBlock' ? `${op.kind} ${op.blockId}` : '';

export function join(shared: Room) {
  const client = shared.inboxes.length;
  const inbox: Message[] = [];
  shared.inboxes.push(inbox);
  const replica = shared.replica();
  const { registry } = replica;
  let seen = 0;
  let inflight: Entry[] = [];
  let buffer: Entry[] = [];
  let waiting = false;
  const done: Entry[][] = [];
  const undone: Entry[][] = [];
  let listener: (ops: readonly RemoteOp[]) => void = () => undefined;

  const remap = (entries: readonly Entry[]) => {
    for (const stack of [done, undone]) {
      stack.splice(0, stack.length, ...stack.map((step) => cross(step, entries, registry)[0]));
    }
  };

  function flush() {
    if (waiting || buffer.length === 0) return;
    [inflight, buffer, waiting] = [buffer, [], true];
    shared.receive(client, seen, inflight);
  }

  function local(ops: readonly RemoteOp[]): Entry[] {
    const inverses: Entry[] = [];
    for (const op of ops) {
      let at = '';
      if (op.kind === 'insertBlock' || op.kind === 'moveBlock') {
        const id = op.kind === 'insertBlock' ? op.block.id : op.blockId;
        const list = listOf(replica, op.parent).filter((other) => other !== id);
        const [before, after] = [list[op.index - 1], list[op.index]].map(
          (each) => each && positionOf(replica, each),
        );
        at = key(before, after, client);
        replica.positions.set(id, at);
      }
      const block = 'blockId' in op ? replica.doc.blocks.get(op.blockId) : undefined;
      const outgoing: RemoteOp =
        op.kind === 'setProps' && block !== undefined
          ? { ...op, kind: 'setType', type: block.type }
          : op;
      const { doc, inverse } = applied(replica.doc, op, registry);
      if (inverse.kind === 'splitBlock' || inverse.kind === 'mergeBlocks')
        throw new Error('not remote');
      replica.doc = doc;
      const entry = { client, op: outgoing, at };
      remap([entry]);
      buffer.push(entry);
      inverses.unshift({ client, op: inverse, at: '' });
    }
    flush();
    return inverses;
  }

  function travel(from: Entry[][], to: Entry[][]): boolean {
    const step = from.pop();
    if (step === undefined) return false;
    const ops = step.map((entry) => entry.op);
    listener(ops);
    to.push(local(ops));
    return true;
  }

  const sent: (readonly RemoteOp[])[] = [];
  const adapter: CollabAdapter = {
    send(ops) {
      sent.push(ops);
      undone.length = 0;
      done.push(local(ops));
    },
    onRemote(apply) {
      listener = apply;
      return () => {
        listener = () => undefined;
      };
    },
    undo: () => travel(done, undone),
    redo: () => travel(undone, done),
  };

  function deliver(count = inbox.length): number {
    const messages = inbox.splice(0, count);
    for (const { client: sender, entries } of messages) {
      seen += entries.length;
      if (sender === client) {
        [inflight, waiting] = [[], false];
        flush();
        continue;
      }
      let incoming: Entry[];
      [incoming, inflight] = cross(entries, inflight, registry);
      [incoming, buffer] = cross(incoming, buffer, registry);
      const mine = new Set([...inflight, ...buffer].map(written));
      incoming = incoming.filter((entry) => written(entry) === '' || !mine.has(written(entry)));
      remap(incoming);
      listener(incoming.flatMap((entry) => absorb(replica, entry)));
    }
    return messages.length;
  }

  return { adapter, deliver, sent };
}
