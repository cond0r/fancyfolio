import type { BlockId, Change, DocView, Parent, Place } from './types.ts';

export function parentsOf({ ids, blocks }: Pick<DocView, 'ids' | 'blocks'>): Map<BlockId, Parent> {
  const parents = new Map<BlockId, Parent>();
  const visit = (list: readonly BlockId[], parent: Parent) => {
    for (const id of list) {
      parents.set(id, parent);
      for (const [slot, children] of Object.entries(blocks.get(id)?.slots ?? {})) {
        visit(children, { blockId: id, slot });
      }
    }
  };
  visit(ids, null);
  return parents;
}

export function viewOf(lists: Pick<DocView, 'ids' | 'blocks'>): DocView {
  const parents = parentsOf(lists);
  return { ids: lists.ids, blocks: lists.blocks, parentOf: (id) => parents.get(id) };
}

export function relinked(
  view: DocView,
  change: Change,
): (readonly [BlockId, Parent | undefined])[] {
  const lists: [Parent, readonly BlockId[], readonly BlockId[]][] = [];
  if (change.ids !== undefined) lists.push([null, view.ids, change.ids]);
  for (const block of change.put) {
    const before = view.blocks.get(block.id)?.slots ?? {};
    const after = block.slots ?? {};
    for (const slot of new Set([...Object.keys(before), ...Object.keys(after)])) {
      lists.push([{ blockId: block.id, slot }, before[slot] ?? [], after[slot] ?? []]);
    }
  }
  const replaced = lists.filter(([, from, to]) => from !== to);
  const outside = (ids: readonly BlockId[], list: readonly BlockId[]) => {
    const kept = new Set(list);
    return ids.filter((id) => !kept.has(id));
  };
  return [
    ...replaced.flatMap(([, from, to]) => outside(from, to).map((id) => [id, undefined] as const)),
    ...replaced.flatMap(([parent, from, to]) =>
      outside(to, from).map((id) => [id, parent] as const),
    ),
  ];
}

export function placeOf(view: DocView, blockId: BlockId): Place | undefined {
  const parent = view.parentOf(blockId);
  if (parent === undefined) return undefined;
  const list =
    parent === null ? view.ids : (view.blocks.get(parent.blockId)?.slots?.[parent.slot] ?? []);
  const index = list.indexOf(blockId);
  if (index === -1) throw new Error(`block ${blockId} is missing from its parent's list`);
  return { parent, list, index };
}

export function childrenOf(view: DocView, blockId: BlockId): readonly BlockId[] | undefined {
  if (view.parentOf(blockId) === undefined) return undefined;
  return Object.values(view.blocks.get(blockId)?.slots ?? {}).flat();
}

export function pathOf(view: DocView, blockId: BlockId): readonly BlockId[] | undefined {
  const path = [blockId];
  let parent = view.parentOf(blockId);
  while (parent !== null) {
    if (parent === undefined) return undefined;
    path.unshift(parent.blockId);
    parent = view.parentOf(parent.blockId);
  }
  return path;
}

export function depthOf(view: DocView, blockId: BlockId): number | undefined {
  const path = pathOf(view, blockId);
  return path === undefined ? undefined : path.length - 1;
}
