import { isRaw } from './model.ts';
import { movable } from './ops.ts';
import type {
  Block,
  BlockId,
  Commands,
  Context,
  DefaultHandlers,
  Handler,
  Op,
  Registered,
  Result,
  Selection,
} from './types.ts';

function caret(blockId: BlockId, field: string, offset: number): Selection {
  return { kind: 'text', blockId, field, from: offset, to: offset };
}

export function caretIn(block: Block): Selection {
  const [field] = Object.keys(block.fields);
  return field === undefined ? { kind: 'blocks', ids: [block.id] } : caret(block.id, field, 0);
}

function soleField(block: Block): string | undefined {
  const [only, ...rest] = Object.keys(block.fields);
  return rest.length === 0 ? only : undefined;
}

function textAt({ doc, selection }: Context) {
  if (selection.kind !== 'text') return undefined;
  const block = doc.blocks.get(selection.blockId);
  return block === undefined ? undefined : { block, ...selection };
}

function cleared({ blockId, field, from, to }: Extract<Selection, { kind: 'text' }>): Op[] {
  return from < to ? [{ kind: 'deleteText', blockId, field, from, to }] : [];
}

function textOf(block: Block): string {
  return Object.values(block.fields).join('');
}

function caretAtEnd(block: Block): Selection {
  const [field] = Object.keys(block.fields);
  return field === undefined
    ? caretIn(block)
    : caret(block.id, field, (block.fields[field] ?? '').length);
}

function codePointBefore(text: string, offset: number): number {
  return offset - ((text.codePointAt(offset - 2) ?? 0) > 0xffff ? 2 : 1);
}

function codePointAfter(text: string, offset: number): number {
  return offset + ((text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1);
}

function deleting(blockId: BlockId, field: string, from: number, to: number): Result {
  return {
    ops: [{ kind: 'deleteText', blockId, field, from, to }],
    selection: caret(blockId, field, from),
  };
}

function removing({ doc, newId }: Context, ids: readonly BlockId[]): Result {
  const removed = new Set(ids);
  const ops: Op[] = [...removed].map((blockId) => ({ kind: 'removeBlock', blockId }));
  const first = doc.ids.findIndex((id) => removed.has(id));
  if (first === -1) return undefined;
  const kept = doc.ids.filter((id) => !removed.has(id));
  const afterId = doc.ids.slice(first).find((id) => !removed.has(id));
  const after = afterId === undefined ? undefined : doc.blocks.get(afterId);
  if (after !== undefined) return { ops, selection: caretIn(after) };
  const beforeId = kept.at(-1);
  const before = beforeId === undefined ? undefined : doc.blocks.get(beforeId);
  if (before !== undefined) return { ops, selection: caretAtEnd(before) };
  const id = newId();
  const block: Block = { id, type: 'paragraph', props: {}, fields: { text: '' } };
  return {
    ops: [{ kind: 'insertBlock', block, parent: null, index: 0 }, ...ops],
    selection: caret(id, 'text', 0),
  };
}

function merging(context: Context, offset: -1 | 1): Result {
  const at = textAt(context);
  if (at === undefined || at.from !== at.to || soleField(at.block) !== at.field) return undefined;
  const { doc } = context;
  const neighbourId = doc.ids[doc.ids.indexOf(at.blockId) + offset];
  const neighbour = neighbourId === undefined ? undefined : doc.blocks.get(neighbourId);
  if (neighbour === undefined || soleField(neighbour) === undefined) return undefined;
  const [head, tail] = offset === -1 ? [neighbour, at.block] : [at.block, neighbour];
  if (movable(tail.type, head.type, textOf(head), textOf(tail))) {
    return { ops: [{ kind: 'mergeBlocks', blockId: tail.id }], selection: caretAtEnd(head) };
  }
  if (!isRaw(head.type)) return undefined;
  return { ops: [], selection: offset === -1 ? caretAtEnd(neighbour) : caretIn(neighbour) };
}

function selected(context: Context): Result {
  const { selection } = context;
  if (selection.kind === 'blocks') return removing(context, selection.ids);
  const { blockId, field, from, to } = selection;
  return from < to ? deleting(blockId, field, from, to) : undefined;
}

const none = () => undefined;

const defaults: DefaultHandlers = {
  insertText(context, { text }) {
    const at = textAt(context);
    if (at === undefined || text === '') return undefined;
    const typed: Op = {
      kind: 'insertText',
      blockId: at.blockId,
      field: at.field,
      offset: at.from,
      text,
    };
    return {
      ops: [...cleared(at), typed],
      selection: caret(at.blockId, at.field, at.from + text.length),
    };
  },
  insertBreak(context) {
    const at = textAt(context);
    if (at === undefined || soleField(at.block) !== at.field) return undefined;
    const text = at.block.fields[at.field] ?? '';
    if (!movable(at.block.type, 'paragraph', text.slice(0, at.from), text.slice(at.to))) {
      return undefined;
    }
    const newId = context.newId();
    const split: Op = {
      kind: 'splitBlock',
      blockId: at.blockId,
      field: at.field,
      offset: at.from,
      newId,
      type: 'paragraph',
      props: {},
    };
    return { ops: [...cleared(at), split], selection: caret(newId, 'text', 0) };
  },
  deleteBackward(context) {
    const at = textAt(context);
    if (at === undefined || at.from < at.to || at.from === 0) {
      return selected(context) ?? merging(context, -1);
    }
    const text = at.block.fields[at.field] ?? '';
    return deleting(at.blockId, at.field, codePointBefore(text, at.from), at.from);
  },
  deleteForward(context) {
    const at = textAt(context);
    const text = at === undefined ? '' : (at.block.fields[at.field] ?? '');
    if (at === undefined || at.from < at.to || at.from >= text.length) {
      return selected(context) ?? merging(context, 1);
    }
    return deleting(at.blockId, at.field, at.from, codePointAfter(text, at.from));
  },
  deleteSelection: selected,
  undo: none,
  redo: none,
};

export function run<C extends keyof Commands>(
  components: Iterable<Registered>,
  name: C,
  context: Context,
  args: Commands[C],
): Result {
  if (!Object.hasOwn(defaults, name)) throw new RangeError(`unknown command ${name}`);
  const handlers: Handler<Commands[C]>[] = [];
  for (const { commands } of components) {
    const handler =
      commands !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;
    if (handler !== undefined) handlers.push(handler);
  }
  handlers.push(defaults[name]);
  const from = (index: number): Result => {
    const handler = handlers[index];
    if (handler === undefined) return undefined;
    let lower: { readonly result: Result } | undefined;
    const next = () => {
      lower ??= { result: from(index + 1) };
      return lower.result;
    };
    return handler(context, args, next) ?? next();
  };
  return from(0);
}
