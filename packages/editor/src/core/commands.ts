import { emptyParagraph, movable } from './ops.ts';
import { childrenOf, pathOf, placeOf } from './tree.ts';
import type {
  Block,
  BlockId,
  Commands,
  Context,
  DefaultHandlers,
  DocView,
  Handler,
  Op,
  Parent,
  Registered,
  Result,
  Selection,
} from './types.ts';

function caret(blockId: BlockId, field: string, offset: number): Selection {
  return { kind: 'text', blockId, field, from: offset, to: offset };
}

function entered(doc: DocView, block: Block, end: boolean): Block {
  if (Object.keys(block.fields).length > 0) return block;
  const children = Object.values(block.slots ?? {}).flat();
  const id = end ? children.at(-1) : children[0];
  return (id === undefined ? undefined : doc.blocks.get(id)) ?? block;
}

export function caretIn(doc: DocView, outer: Block): Selection {
  const block = entered(doc, outer, false);
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

function caretAtEnd(doc: DocView, outer: Block): Selection {
  const block = entered(doc, outer, true);
  const field = Object.keys(block.fields).at(-1);
  return field === undefined
    ? { kind: 'blocks', ids: [block.id] }
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

function removals(doc: DocView, blockId: BlockId): Op[] {
  return [
    ...(childrenOf(doc, blockId) ?? []).flatMap((child) => removals(doc, child)),
    { kind: 'removeBlock', blockId },
  ];
}

function removing({ doc, newId }: Context, ids: readonly BlockId[]): Result {
  const removed = new Set(ids);
  const roots = [...removed].filter(
    (id) =>
      !pathOf(doc, id)
        ?.slice(0, -1)
        .some((above) => removed.has(above)),
  );
  const ops = roots.flatMap((blockId) => removals(doc, blockId));
  const place = roots.map((id) => placeOf(doc, id)).find((each) => each !== undefined);
  if (place === undefined) return undefined;
  const { list, parent } = place;
  const first = list.findIndex((id) => removed.has(id));
  const afterId = list.slice(first).find((id) => !removed.has(id));
  const after = afterId === undefined ? undefined : doc.blocks.get(afterId);
  if (after !== undefined) return { ops, selection: caretIn(doc, after) };
  const beforeId = list[first - 1];
  const before = beforeId === undefined ? undefined : doc.blocks.get(beforeId);
  if (before !== undefined) return { ops, selection: caretAtEnd(doc, before) };
  const id = newId();
  return {
    ops: [{ kind: 'insertBlock', block: emptyParagraph(id), parent, index: 0 }, ...ops],
    selection: caret(id, 'text', 0),
  };
}

function missing(blockId: BlockId): never {
  throw new Error(`block ${blockId} is missing`);
}

function copies(
  doc: DocView,
  block: Block,
  newId: () => BlockId,
  parent: Parent,
  index: number,
): Op[] {
  const id = newId();
  const slots = Object.entries(block.slots ?? {});
  const copy: Block = {
    ...block,
    id,
    ...(block.slots && { slots: Object.fromEntries(slots.map(([slot]) => [slot, []])) }),
  };
  return [
    { kind: 'insertBlock', block: copy, parent, index },
    ...slots.flatMap(([slot, children]) =>
      children.flatMap((child, at) =>
        copies(doc, doc.blocks.get(child) ?? missing(child), newId, { blockId: id, slot }, at),
      ),
    ),
  ];
}

function merging(context: Context, offset: -1 | 1): Result {
  const at = textAt(context);
  if (at === undefined || at.from !== at.to) return undefined;
  const names = Object.keys(at.block.fields);
  const index = names.indexOf(at.field);
  const before = names[index - 1];
  const after = names[index + 1];
  if (offset === -1 && before !== undefined) {
    return {
      ops: [],
      selection: caret(at.blockId, before, (at.block.fields[before] ?? '').length),
    };
  }
  if (offset === 1 && after !== undefined)
    return { ops: [], selection: caret(at.blockId, after, 0) };
  const { doc } = context;
  const place = placeOf(doc, at.blockId);
  const neighbourId = place?.list[place.index + offset];
  const neighbour = neighbourId === undefined ? undefined : doc.blocks.get(neighbourId);
  if (neighbour === undefined) return undefined;
  const [head, tail] = offset === -1 ? [neighbour, at.block] : [at.block, neighbour];
  if (
    soleField(at.block) === at.field &&
    soleField(neighbour) !== undefined &&
    movable(tail.type, head.type, textOf(head), textOf(tail))
  ) {
    return { ops: [{ kind: 'mergeBlocks', blockId: tail.id }], selection: caretAtEnd(doc, head) };
  }
  return {
    ops: [],
    selection: offset === -1 ? caretAtEnd(doc, neighbour) : caretIn(doc, neighbour),
  };
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
  moveBlockTo({ doc }, { blockId, target, side }) {
    const block = doc.blocks.get(blockId);
    const place = placeOf(doc, target);
    if (block === undefined || place === undefined || pathOf(doc, target)?.includes(blockId)) {
      return undefined;
    }
    const list = place.list.filter((id) => id !== blockId);
    const index = list.indexOf(target) + (side === 'after' ? 1 : 0);
    if (place.list.indexOf(blockId) === index) return undefined;
    return {
      ops: [{ kind: 'moveBlock', blockId, parent: place.parent, index }],
      selection: caretIn(doc, block),
    };
  },
  duplicateBlock({ doc, newId }, { blockId }) {
    const block = doc.blocks.get(blockId);
    const place = placeOf(doc, blockId);
    if (block === undefined || place === undefined) return undefined;
    return { ops: copies(doc, block, newId, place.parent, place.index + 1) };
  },
  insertBlockAfter({ doc, newId, shapeOf }, { blockId, type, props }) {
    const place = placeOf(doc, blockId);
    const shape = shapeOf(type);
    if (place === undefined || shape === undefined) return undefined;
    const id = newId();
    const fills = shape.slots.map((slot) => ({ slot, fill: newId() }));
    const block: Block = {
      id,
      type,
      props,
      fields: Object.fromEntries(shape.fields.map((field) => [field, ''])),
      ...(fills.length > 0 && { slots: Object.fromEntries(fills.map(({ slot }) => [slot, []])) }),
    };
    const [field] = shape.fields;
    const [first] = fills;
    return {
      ops: [
        { kind: 'insertBlock', block, parent: place.parent, index: place.index + 1 },
        ...fills.map(
          ({ slot, fill }): Op => ({
            kind: 'insertBlock',
            block: emptyParagraph(fill),
            parent: { blockId: id, slot },
            index: 0,
          }),
        ),
      ],
      selection:
        field !== undefined
          ? caret(id, field, 0)
          : first !== undefined
            ? caret(first.fill, 'text', 0)
            : { kind: 'blocks', ids: [id] },
    };
  },
  turnInto({ doc, selection, shapeOf }, { blockId, type, props, replace }) {
    const block = doc.blocks.get(blockId);
    const shape = shapeOf(type);
    if (block === undefined || shape === undefined) return undefined;
    const cut = Object.entries(block.fields).flatMap(([field, text]): Op[] =>
      replace && text !== ''
        ? [{ kind: 'deleteText', blockId, field, from: 0, to: text.length }]
        : [],
    );
    const kept =
      !replace &&
      selection.kind === 'text' &&
      selection.blockId === blockId &&
      shape.fields.includes(selection.field);
    const [field] = shape.fields;
    return {
      ops: [...cut, { kind: 'setType', blockId, type, props }],
      selection: kept
        ? selection
        : field === undefined
          ? { kind: 'blocks', ids: [blockId] }
          : caret(blockId, field, 0),
    };
  },
  toggleMark: none,
  setCase: none,
  setLink: none,
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
