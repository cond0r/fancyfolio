import { type Atom, atom, createStore, type PrimitiveAtom, type Store } from 'jotai/vanilla';
import { emptyHistory, record, redo, undo } from './history.ts';
import { load, type SaveResult, save } from './markdown.ts';
import { type Block, type BlockId, type Doc, type DocView, docOf } from './model.ts';
import { type Op, plan } from './ops.ts';

export type Editor = {
  readonly store: Store;
  readonly ids: Atom<readonly BlockId[]>;
  readonly blocks: ReadonlyMap<BlockId, Atom<Block>>;
  dispatch(op: Op): void;
  undo(): boolean;
  redo(): boolean;
  doc(): Doc;
  markdown(): SaveResult;
};

export type EditorOptions = {
  readonly now: () => number;
  readonly newId: () => BlockId;
};

export function createEditor(markdown: string, options: EditorOptions): Editor {
  const store = createStore();
  const initial = load(markdown, options.newId);
  const ids = atom(initial.ids);
  const blocks = new Map<BlockId, PrimitiveAtom<Block>>();
  for (const [id, block] of initial.blocks) blocks.set(id, atom(block));
  const retired = new WeakMap<Op, PrimitiveAtom<Block>>();
  let history = emptyHistory;

  const view: DocView = {
    get ids() {
      return store.get(ids);
    },
    blocks: {
      get(id) {
        const block = blocks.get(id);
        return block === undefined ? undefined : store.get(block);
      },
    },
  };

  function commit(input: Op, recorded?: Op): { op: Op; reverse: Op } {
    const { op, change, inverse } = plan(view, input);
    const reverse = recorded ?? inverse;
    for (const block of change.put) {
      const existing = blocks.get(block.id) ?? retired.get(input);
      if (existing === undefined) blocks.set(block.id, atom(block));
      else {
        store.set(existing, block);
        blocks.set(block.id, existing);
      }
    }
    if (change.ids !== undefined) store.set(ids, change.ids);
    for (const id of change.drop) {
      const dropped = blocks.get(id);
      if (dropped !== undefined) retired.set(reverse, dropped);
      blocks.delete(id);
    }
    return { op, reverse };
  }

  function travel(move: typeof undo): boolean {
    const moved = move(history);
    if (moved === undefined) return false;
    commit(moved.op, moved.inverse);
    history = moved.history;
    return true;
  }

  function doc(): Doc {
    const order = store.get(ids);
    return docOf(
      order.map((id) => {
        const block = view.blocks.get(id);
        if (block === undefined) throw new Error(`block ${id} has no atom`);
        return block;
      }),
      initial.sources,
    );
  }

  return {
    store,
    ids,
    blocks,
    dispatch(input) {
      const { op, reverse } = commit(input);
      history = record(history, op, reverse, options.now());
    },
    undo: () => travel(undo),
    redo: () => travel(redo),
    doc,
    markdown: () => save(doc()),
  };
}
