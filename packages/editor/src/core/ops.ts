import {
  type Block,
  type BlockId,
  type BlockKind,
  type Doc,
  type DocView,
  type HeadingLevel,
  isCanonicalText,
  isRaw,
  isSameKind,
  kindOf,
  withKind,
} from './model.ts';

export type Op =
  | {
      readonly type: 'insertText';
      readonly id: BlockId;
      readonly offset: number;
      readonly text: string;
    }
  | {
      readonly type: 'deleteText';
      readonly id: BlockId;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly type: 'splitBlock';
      readonly id: BlockId;
      readonly offset: number;
      readonly newId: BlockId;
      readonly kind: BlockKind;
    }
  | { readonly type: 'mergeBlocks'; readonly id: BlockId }
  | { readonly type: 'setType'; readonly id: BlockId; readonly kind: BlockKind };

export type Change = {
  readonly put: readonly Block[];
  readonly ids?: readonly BlockId[];
  readonly drop: readonly BlockId[];
};

function refuse(op: Op, reason: string): never {
  throw new RangeError(`${op.type} refused: ${reason}`);
}

function offsetIn(op: Op, text: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    refuse(op, 'offset outside the text');
  }
  return offset;
}

function withText(op: Op, block: Block, text: string): Block {
  if (!isCanonicalText(text)) refuse(op, 'text is not canonical');
  return { ...block, text };
}

function isId(id: unknown): id is BlockId {
  return typeof id === 'string' && id !== '';
}

function field(input: unknown, key: string): unknown {
  return typeof input === 'object' && input !== null && key in input
    ? Reflect.get(input, key)
    : undefined;
}

function isLevel(level: unknown): level is HeadingLevel {
  return typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6;
}

function kindFrom(input: unknown): BlockKind | undefined {
  const type = field(input, 'type');
  if (type === 'paragraph' || type === 'raw') return Object.freeze({ type });
  if (type !== 'heading') return undefined;
  const level = field(input, 'level');
  return isLevel(level) ? Object.freeze({ type, level }) : undefined;
}

function opFrom(input: unknown): Op | undefined {
  const type = field(input, 'type');
  const id = field(input, 'id');
  if (!isId(id)) return undefined;
  switch (type) {
    case 'insertText': {
      const offset = field(input, 'offset');
      const text = field(input, 'text');
      return typeof offset === 'number' && typeof text === 'string'
        ? { type, id, offset, text }
        : undefined;
    }
    case 'deleteText': {
      const from = field(input, 'from');
      const to = field(input, 'to');
      return typeof from === 'number' && typeof to === 'number'
        ? { type, id, from, to }
        : undefined;
    }
    case 'splitBlock': {
      const offset = field(input, 'offset');
      const newId = field(input, 'newId');
      const kind = kindFrom(field(input, 'kind'));
      return typeof offset === 'number' && isId(newId) && kind !== undefined
        ? { type, id, offset, newId, kind }
        : undefined;
    }
    case 'mergeBlocks':
      return { type, id };
    case 'setType': {
      const kind = kindFrom(field(input, 'kind'));
      return kind === undefined ? undefined : { type, id, kind };
    }
    default:
      return undefined;
  }
}

function toOp(input: unknown): Op {
  const op = opFrom(input);
  if (op === undefined) throw new RangeError('op refused: not an editor op');
  return Object.freeze(op);
}

function crossing(op: Op, from: BlockKind, to: BlockKind, text: string) {
  if (text !== '' && isRaw(from) !== isRaw(to)) {
    refuse(op, 'text cannot move between raw source and plain text');
  }
}

function joining(op: Op, head: BlockKind, headText: string, tail: BlockKind, tailText: string) {
  if (isRaw(head) && isRaw(tail) && headText !== '' && tailText !== '') {
    refuse(op, 'raw source is never joined or cut');
  }
}

export function plan(view: DocView, input: unknown): { op: Op; change: Change; inverse: Op } {
  const op = toOp(input);
  return { op, ...planned(view, op) };
}

function planned(view: DocView, op: Op): { change: Change; inverse: Op } {
  const block = view.blocks.get(op.id) ?? refuse(op, 'unknown block');
  const { text } = block;
  switch (op.type) {
    case 'insertText': {
      const offset = offsetIn(op, text, op.offset);
      if (op.text === '') refuse(op, 'nothing to insert');
      const next = withText(op, block, text.slice(0, offset) + op.text + text.slice(offset));
      return {
        change: { put: [next], drop: [] },
        inverse: { type: 'deleteText', id: op.id, from: offset, to: offset + op.text.length },
      };
    }
    case 'deleteText': {
      const from = offsetIn(op, text, op.from);
      const to = offsetIn(op, text, op.to);
      if (from >= to) refuse(op, 'empty range');
      const next = withText(op, block, text.slice(0, from) + text.slice(to));
      return {
        change: { put: [next], drop: [] },
        inverse: { type: 'insertText', id: op.id, offset: from, text: text.slice(from, to) },
      };
    }
    case 'splitBlock': {
      const offset = offsetIn(op, text, op.offset);
      if (view.blocks.get(op.newId) !== undefined) refuse(op, 'id taken');
      crossing(op, block, op.kind, text.slice(offset));
      joining(op, block, text.slice(0, offset), op.kind, text.slice(offset));
      const head = withText(op, block, text.slice(0, offset));
      const tail = withKind(op.kind, op.newId, text.slice(offset));
      const ids = [...view.ids];
      ids.splice(ids.indexOf(op.id) + 1, 0, op.newId);
      return {
        change: { put: [head, tail], ids, drop: [] },
        inverse: { type: 'mergeBlocks', id: op.newId },
      };
    }
    case 'mergeBlocks': {
      const previousId = view.ids[view.ids.indexOf(op.id) - 1];
      const previous = previousId === undefined ? undefined : view.blocks.get(previousId);
      if (previous === undefined) refuse(op, 'no block before');
      crossing(op, block, previous, text);
      joining(op, previous, previous.text, block, text);
      return {
        change: {
          put: [{ ...previous, text: previous.text + text }],
          ids: view.ids.filter((id) => id !== op.id),
          drop: [op.id],
        },
        inverse: {
          type: 'splitBlock',
          id: previous.id,
          offset: previous.text.length,
          newId: op.id,
          kind: kindOf(block),
        },
      };
    }
    case 'setType':
      if (isSameKind(op.kind, block)) refuse(op, 'block already has that kind');
      crossing(op, block, op.kind, text);
      return {
        change: { put: [withKind(op.kind, op.id, text)], drop: [] },
        inverse: { type: 'setType', id: op.id, kind: kindOf(block) },
      };
  }
}

export function apply(doc: Doc, op: Op): { doc: Doc; inverse: Op } {
  const { change, inverse } = plan(doc, op);
  const blocks = new Map(doc.blocks);
  for (const id of change.drop) blocks.delete(id);
  for (const block of change.put) blocks.set(block.id, block);
  return { doc: { ids: change.ids ?? doc.ids, blocks, sources: doc.sources }, inverse };
}
