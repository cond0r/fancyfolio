import { atom, createStore, type PrimitiveAtom } from 'jotai/vanilla';
import { lowered, neighbours, remapped } from './collab.ts';
import { caretIn, run } from './commands.ts';
import { emptyHistory, record, redo, undo } from './history.ts';
import { load, save } from './markdown.ts';
import { planAll } from './ops.ts';
import { registryOf } from './registry.ts';
import type {
  Block,
  BlockId,
  Change,
  Doc,
  DocView,
  Editor,
  EditorOptions,
  Op,
  RemoteOp,
  Selection,
} from './types.ts';

export function createEditor(markdown: string, options: EditorOptions): Editor {
  const registry = registryOf(options.components ?? []);
  const store = createStore();
  const initial = load(markdown, options.newId, registry);
  const ids = atom(initial.ids);
  const blocks = new Map<BlockId, PrimitiveAtom<Block>>();
  for (const [id, block] of initial.blocks) blocks.set(id, atom(block));
  const retired = new WeakMap<Op, PrimitiveAtom<Block>>();
  const [first] = initial.ids;
  const firstBlock = first === undefined ? undefined : initial.blocks.get(first);
  if (firstBlock === undefined) throw new Error('the document has no first block');
  const selection = atom<Selection>(caretIn(initial, firstBlock));
  let history = emptyHistory;
  const { collab } = options;

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

  function write(change: Change, input: Op, reverse: Op) {
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
  }

  function commit(inputs: readonly Op[], transformed: boolean, recorded?: readonly Op[]) {
    const planned = planAll(view, inputs, registry, transformed);
    const inverses = recorded ?? planned.map((each) => each.inverse);
    planned.forEach(({ change, op }, index) => {
      write(change, inputs[index] ?? op, inverses[index]);
    });
    return planned;
  }

  function travel(move: typeof undo): boolean {
    const moved = move(history);
    if (moved === undefined) return false;
    commit(moved.ops, false, moved.inverses);
    history = moved.history;
    store.set(selection, moved.selection);
    return true;
  }

  function step(inputs: readonly Op[], after: Selection) {
    const before = store.get(selection);
    const planned = commit(inputs, true);
    if (collab !== undefined) {
      collab.send(lowered(planned));
      return;
    }
    const ops = planned.map((each) => each.op);
    const inverses = planned.map((each) => each.inverse);
    history = record(history, { ops, inverses, before, after }, options.now());
  }

  function receive(ops: readonly RemoteOp[]) {
    for (const op of ops) {
      if ('blockId' in op && view.blocks.get(op.blockId) === undefined) continue;
      const near = op.kind === 'removeBlock' ? neighbours(view, op.blockId) : [];
      try {
        commit([op], false);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        console.error(error);
        continue;
      }
      store.set(selection, remapped(view, store.get(selection), op, near, registry));
    }
  }

  const undoing = () => (collab === undefined ? travel(undo) : collab.undo());
  const redoing = () => (collab === undefined ? travel(redo) : collab.redo());

  function dispatch(...inputs: Op[]) {
    step(inputs, store.get(selection));
  }

  function doc(): Doc {
    const order = store.get(ids);
    const all = new Map<BlockId, Block>();
    const visit = (id: BlockId) => {
      const block = view.blocks.get(id);
      if (block === undefined) throw new Error(`block ${id} has no atom`);
      all.set(id, block);
      for (const children of Object.values(block.slots ?? {})) children.forEach(visit);
    };
    order.forEach(visit);
    return { ids: order, blocks: all, sources: initial.sources };
  }

  collab?.onRemote(receive);

  return {
    store,
    ids,
    blocks,
    selection,
    dispatch,
    command(name, args) {
      const context = { doc: view, selection: store.get(selection), newId: options.newId };
      const result = run(registry.components.values(), name, context, args);
      if (result === undefined) {
        if (name === 'undo') return undoing();
        return name === 'redo' && redoing();
      }
      if (result.ops.length > 0) step(result.ops, result.selection ?? store.get(selection));
      if (result.selection !== undefined) store.set(selection, result.selection);
      return true;
    },
    undo: undoing,
    redo: redoing,
    doc,
    markdown: () => save(doc(), registry),
  };
}
