import { caretIn } from './commands.ts';
import { mapIn, placeOf } from './ops.ts';
import type {
  Block,
  BlockId,
  Change,
  Doc,
  DocView,
  Parent,
  Planned,
  Presence,
  Registry,
  RemoteOp,
  Selection,
} from './types.ts';

function putIn(change: Change, id: BlockId): Block {
  const block = change.put.find((each) => each.id === id);
  if (block === undefined) throw new Error(`block ${id} is missing from its change`);
  return block;
}

function listedIn(change: Change, id: BlockId): { parent: Parent; index: number } {
  const top = change.ids?.indexOf(id) ?? -1;
  if (top !== -1) return { parent: null, index: top };
  for (const owner of change.put) {
    for (const [slot, list] of Object.entries(owner.slots ?? {})) {
      const index = list.indexOf(id);
      if (index !== -1) return { parent: { blockId: owner.id, slot }, index };
    }
  }
  throw new Error(`block ${id} is in no list of its change`);
}

export function inserts(doc: Doc): RemoteOp[] {
  const blockOf = (id: BlockId): Block => {
    const block = doc.blocks.get(id);
    if (block === undefined) throw new RangeError(`the doc lists a missing block ${id}`);
    return block;
  };
  return doc.ids.flatMap((id, index): RemoteOp[] => {
    const block = blockOf(id);
    const lists = Object.entries(block.slots ?? {});
    const slots = Object.fromEntries(lists.map(([slot]) => [slot, []]));
    const children = lists.flatMap(([slot, list]) =>
      list.map(
        (child, at): RemoteOp => ({
          kind: 'insertBlock',
          block: blockOf(child),
          parent: { blockId: id, slot },
          index: at,
        }),
      ),
    );
    const emptied = block.slots === undefined ? block : { ...block, slots };
    return [{ kind: 'insertBlock', block: emptied, parent: null, index }, ...children];
  });
}

export function lowered(steps: readonly Planned[]): RemoteOp[] {
  return steps.flatMap(({ op, change, inverse }): RemoteOp[] => {
    if (op.kind === 'splitBlock') {
      const block = putIn(change, op.newId);
      const tail = Object.values(block.fields).join('');
      const { blockId, field, offset } = op;
      const cut: RemoteOp[] =
        tail === ''
          ? []
          : [{ kind: 'deleteText', blockId, field, from: offset, to: offset + tail.length }];
      return [...cut, { kind: 'insertBlock', block, ...listedIn(change, op.newId) }];
    }
    if (op.kind !== 'mergeBlocks') return [op];
    if (inverse.kind !== 'splitBlock') throw new Error('a merge inverts to a split');
    const { blockId, field, offset } = inverse;
    const text = putIn(change, blockId).fields[field].slice(offset);
    const joined: RemoteOp[] =
      text === '' ? [] : [{ kind: 'insertText', blockId, field, offset, text }];
    return [...joined, { kind: 'removeBlock', blockId: op.blockId }];
  });
}

export function presenceAfter(
  ops: readonly RemoteOp[],
  presence: Presence,
  registry: Registry,
): Presence | undefined {
  const { blockId, field } = presence;
  let { from, to } = presence;
  for (const op of ops) {
    const start = mapIn(registry, op, { blockId, field, offset: from });
    const end = mapIn(registry, op, { blockId, field, offset: to });
    if (start === undefined || end === undefined) return undefined;
    [from, to] = [start.offset, end.offset];
  }
  return from === presence.from && to === presence.to ? presence : { ...presence, from, to };
}

export function neighbours(view: DocView, blockId: BlockId): BlockId[] {
  const list = placeOf(view, blockId)?.list ?? [];
  const index = list.indexOf(blockId);
  return [list[index + 1], list[index - 1]].filter((id) => id !== undefined);
}

function nearest(view: DocView, near: readonly BlockId[]): Selection {
  for (const id of [...near, ...view.ids]) {
    const block = view.blocks.get(id);
    if (block !== undefined) return caretIn(view, block);
  }
  return { kind: 'blocks', ids: [] };
}

export function remapped(
  view: DocView,
  selection: Selection,
  op: RemoteOp,
  near: readonly BlockId[],
  registry: Registry,
): Selection {
  if (selection.kind === 'blocks') {
    const ids = selection.ids.filter((id) => view.blocks.get(id) !== undefined);
    if (ids.length === selection.ids.length) return selection;
    return ids.length > 0 ? { kind: 'blocks', ids } : nearest(view, near);
  }
  const { blockId, field } = selection;
  const from = mapIn(registry, op, { blockId, field, offset: selection.from });
  const to = mapIn(registry, op, { blockId, field, offset: selection.to });
  if (from === undefined || to === undefined) {
    const block = view.blocks.get(blockId);
    return block === undefined ? nearest(view, near) : caretIn(view, block);
  }
  if (from.offset === selection.from && to.offset === selection.to) return selection;
  return { ...selection, from: from.offset, to: to.offset };
}
