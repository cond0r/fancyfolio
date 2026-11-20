import { atom, createStore, type PrimitiveAtom } from 'jotai/vanilla';
import { selectAtom } from 'jotai/vanilla/utils';
import { inserts, lowered, neighbours, presenceAfter, remapped } from './collab.ts';
import { caretIn, run } from './commands.ts';
import { emptyHistory, record, redo, undo } from './history.ts';
import { load, save } from './markdown.ts';
import { planAll } from './ops.ts';
import { registryOf } from './registry.ts';
import { parentsOf, relinked } from './tree.ts';
import type {
  Block,
  BlockId,
  Change,
  Commands,
  Doc,
  DocView,
  Editor,
  EditorOptions,
  Mark,
  Op,
  Planned,
  Presence,
  RemoteOp,
  Result,
  SaveOutcome,
  SaveState,
  Selection,
  Shape,
} from './types.ts';

const empty: Doc = { ids: [], blocks: new Map(), sources: new Map() };

export function createEditor(source: string | Doc, options: EditorOptions): Editor {
  const registry = { ...registryOf(options.components ?? []), safeHref: options.safeHref };
  const store = createStore();
  const initial = typeof source === 'string' ? load(source, options.newId, registry) : empty;
  const ids = atom(initial.ids);
  const blocks = new Map<BlockId, PrimitiveAtom<Block>>();
  for (const [id, block] of initial.blocks) blocks.set(id, atom(block));
  const retired = new WeakMap<Op, PrimitiveAtom<Block>>();
  const parents = parentsOf(initial);
  const selection = atom<Selection>({ kind: 'blocks', ids: [] });
  let history = emptyHistory;
  const { collab } = options;
  const saveState = atom<SaveState>('idle');
  let saving =
    options.onSave === undefined ? undefined : { onSave: options.onSave, version: options.version };
  let pending: Promise<SaveOutcome> | undefined;
  let revision = 0;
  const others = atom<readonly Presence[]>([]);
  let connected = true;

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
    parentOf: (id) => parents.get(id),
  };

  function write(change: Change, input: Op, reverse: Op) {
    for (const [id, parent] of relinked(view, change)) {
      if (parent === undefined) parents.delete(id);
      else parents.set(id, parent);
    }
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

  function commit(inputs: readonly Op[], recorded?: readonly Op[]) {
    return written(inputs, planAll(view, inputs, registry), recorded);
  }

  function written(inputs: readonly Op[], planned: readonly Planned[], recorded?: readonly Op[]) {
    const inverses = recorded ?? planned.map((each) => each.inverse);
    planned.forEach(({ change, op }, index) => {
      write(change, inputs[index] ?? op, inverses[index]);
    });
    if (planned.length > 0) {
      revision += 1;
      if (store.get(saveState) === 'saved') store.set(saveState, 'idle');
    }
    follow(planned);
    return planned;
  }

  function follow(planned: readonly Planned[]) {
    const before = store.get(others);
    if (before.length === 0) return;
    const ops = lowered(planned);
    const after = before.flatMap((each) => presenceAfter(ops, each, registry) ?? []);
    if (after.length !== before.length || after.some((each, i) => each !== before[i])) {
      store.set(others, after);
    }
  }

  function travel(move: typeof undo): boolean {
    const moved = move(history);
    if (moved === undefined) return false;
    commit(moved.ops, moved.inverses);
    history = moved.history;
    store.set(selection, moved.selection);
    return true;
  }

  function step(
    inputs: readonly Op[],
    after: Selection,
    planned = planAll(view, inputs, registry, options.newId),
  ) {
    const before = store.get(selection);
    written(inputs, planned);
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
        commit([op]);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        console.error(error);
        continue;
      }
      store.set(selection, remapped(view, store.get(selection), op, near, registry));
    }
  }

  const undoing = () => connected && (collab === undefined ? travel(undo) : collab.undo());
  const redoing = () => connected && (collab === undefined ? travel(redo) : collab.redo());

  function dispatch(...inputs: Op[]) {
    if (connected) step(inputs, store.get(selection));
  }

  function started(text: string, marks: readonly Mark[], blockId: BlockId): Result {
    const block: Block = { id: blockId, type: 'paragraph', props: {}, fields: { text: '' } };
    const plain = { kind: 'insertText', blockId, field: 'text', offset: 0, text } as const;
    const typed = marks.length > 0 ? { ...plain, marks } : plain;
    const end = text.length;
    return {
      ops: [{ kind: 'insertBlock', block, parent: null, index: 0 }, typed],
      selection: { kind: 'text', blockId, field: 'text', from: end, to: end },
    };
  }

  function shapeOf(type: string): Shape | undefined {
    const component = registry.components.get(type);
    return component && { fields: component.fields, slots: component.slots ?? [] };
  }

  function resolved<C extends keyof Commands>(name: C, args: Commands[C], newId: () => BlockId) {
    if (name === 'insertText' && view.ids.length === 0 && 'text' in args) {
      const { text, marks = [] } = args;
      return typeof text === 'string' && text !== '' ? started(text, marks, newId()) : undefined;
    }
    const context = { doc: view, selection: store.get(selection), newId, shapeOf };
    return run(registry.components.values(), name, context, args);
  }

  function accepted(ops: readonly Op[], newId: () => BlockId): Planned[] | undefined {
    try {
      return planAll(view, ops, registry, newId);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return undefined;
    }
  }

  function throwaway(): () => BlockId {
    let next = 0;
    return () => {
      let id: BlockId;
      do {
        id = `can-${next}`;
        next += 1;
      } while (view.blocks.get(id) !== undefined);
      return id;
    };
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

  const check = () => save(doc(), registry);

  function persist(): Promise<SaveOutcome> {
    if (pending !== undefined) return pending;
    if (saving === undefined) return Promise.reject(new Error('the editor has no onSave'));
    const checked = check();
    if (!checked.ok) {
      store.set(saveState, 'failed');
      return Promise.resolve(checked);
    }
    store.set(saveState, 'saving');
    const { onSave, version } = saving;
    const saved = revision;
    pending = Promise.resolve()
      .then(() => onSave(checked.markdown, version))
      .then(
        (stored) => {
          if (!stored.ok) store.set(saveState, 'stale');
          else {
            saving = { onSave, version: stored.version };
            store.set(saveState, revision === saved ? 'saved' : 'idle');
          }
          return stored;
        },
        (error: unknown) => {
          store.set(saveState, 'failed');
          throw error;
        },
      )
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  const seed = typeof source === 'string' ? [] : inserts(source);
  if (seed.length > 0) commit(seed);
  const first = view.blocks.get(view.ids[0] ?? '');
  if (first !== undefined) store.set(selection, caretIn(view, first));
  const unsubscribe = collab?.onRemote(receive);

  return {
    store,
    ids,
    blocks,
    selection,
    view,
    dispatch,
    command(name, args) {
      if (!connected) return false;
      const result = resolved(name, args, options.newId);
      if (result === undefined) {
        if (name === 'undo') return undoing();
        return name === 'redo' && redoing();
      }
      if (result.ops.length > 0) {
        const planned = accepted(result.ops, options.newId);
        if (planned === undefined) return false;
        step(result.ops, result.selection ?? store.get(selection), planned);
      }
      if (result.selection !== undefined) store.set(selection, result.selection);
      return true;
    },
    can(name, args) {
      if (!connected) return false;
      const newId = throwaway();
      const result = resolved(name, args, newId);
      return (
        result !== undefined &&
        (result.ops.length === 0 || accepted(result.ops, newId) !== undefined)
      );
    },
    undo: undoing,
    redo: redoing,
    doc,
    markdown: check,
    saveState,
    save: persist,
    setPresence(next) {
      store.set(others, next);
    },
    presence: (blockId) =>
      selectAtom(
        others,
        (all) => all.filter((each) => each.blockId === blockId),
        (a, b) => a.length === b.length && a.every((each, i) => each === b[i]),
      ),
    disconnect() {
      unsubscribe?.();
      connected = false;
    },
  };
}
