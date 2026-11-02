import { isCanonicalText, isRaw, isRecord, jsonOf, sameJson } from './model.ts';
import { builtins, fieldsFor, propsFor } from './registry.ts';
import type {
  Block,
  BlockId,
  Change,
  Doc,
  DocView,
  Json,
  Op,
  Parent,
  Planned,
  Registered,
  Registry,
} from './types.ts';

function refuse(op: Op, reason: string): never {
  throw new RangeError(`${op.kind} refused: ${reason}`);
}

function offsetIn(op: Op, text: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    refuse(op, 'offset outside the text');
  }
  return offset;
}

function isId(id: unknown): id is BlockId {
  return typeof id === 'string' && id !== '';
}

function field(input: unknown, key: string): unknown {
  return typeof input === 'object' && input !== null && key in input
    ? Reflect.get(input, key)
    : undefined;
}

function blockFrom(input: unknown): Block | undefined {
  const id = field(input, 'id');
  const type = field(input, 'type');
  const props = jsonOf(field(input, 'props'));
  const fields = field(input, 'fields');
  if (!isId(id) || typeof type !== 'string' || props === undefined || !isRecord(fields)) {
    return undefined;
  }
  const entries: [string, string][] = [];
  for (const [name, text] of Object.entries(fields)) {
    if (typeof text !== 'string') return undefined;
    entries.push([name, text]);
  }
  return Object.freeze({ id, type, props, fields: Object.freeze(Object.fromEntries(entries)) });
}

function parentFrom(input: unknown): Parent | undefined {
  if (input === null) return null;
  const blockId = field(input, 'blockId');
  const slot = field(input, 'slot');
  return isId(blockId) && typeof slot === 'string' ? Object.freeze({ blockId, slot }) : undefined;
}

function opFrom(input: unknown): Op | undefined {
  const kind = field(input, 'kind');
  if (kind === 'insertBlock') {
    const block = blockFrom(field(input, 'block'));
    const parent = parentFrom(field(input, 'parent'));
    const index = field(input, 'index');
    return block !== undefined && parent !== undefined && typeof index === 'number'
      ? { kind, block, parent, index }
      : undefined;
  }
  const blockId = field(input, 'blockId');
  if (!isId(blockId)) return undefined;
  switch (kind) {
    case 'insertText': {
      const fieldName = field(input, 'field');
      const offset = field(input, 'offset');
      const text = field(input, 'text');
      return typeof fieldName === 'string' && typeof offset === 'number' && typeof text === 'string'
        ? { kind, blockId, field: fieldName, offset, text }
        : undefined;
    }
    case 'deleteText': {
      const fieldName = field(input, 'field');
      const from = field(input, 'from');
      const to = field(input, 'to');
      return typeof fieldName === 'string' && typeof from === 'number' && typeof to === 'number'
        ? { kind, blockId, field: fieldName, from, to }
        : undefined;
    }
    case 'splitBlock': {
      const fieldName = field(input, 'field');
      const offset = field(input, 'offset');
      const newId = field(input, 'newId');
      const type = field(input, 'type');
      const props = jsonOf(field(input, 'props'));
      return typeof fieldName === 'string' &&
        typeof offset === 'number' &&
        isId(newId) &&
        typeof type === 'string' &&
        props !== undefined
        ? { kind, blockId, field: fieldName, offset, newId, type, props }
        : undefined;
    }
    case 'setType': {
      const type = field(input, 'type');
      const props = jsonOf(field(input, 'props'));
      return typeof type === 'string' && props !== undefined
        ? { kind, blockId, type, props }
        : undefined;
    }
    case 'setProps': {
      const props = jsonOf(field(input, 'props'));
      return props === undefined ? undefined : { kind, blockId, props };
    }
    case 'mergeBlocks':
      return { kind, blockId };
    case 'removeBlock':
      return { kind, blockId };
    default:
      return undefined;
  }
}

function toOp(input: unknown): Op {
  const op = opFrom(input);
  if (op === undefined) throw new RangeError('op refused: not an editor op');
  return Object.freeze(op);
}

function componentOf(op: Op, registry: Registry, type: string): Registered {
  return registry.components.get(type) ?? refuse(op, 'unknown block type');
}

function propsOf(op: Op, component: Registered, props: unknown): Json {
  return propsFor(component, props) ?? refuse(op, 'props fail the schema');
}

function soleField(op: Op, component: Registered): string {
  const [only, ...rest] = component.fields;
  if (only === undefined || rest.length > 0) refuse(op, 'the block has more than one field');
  return only;
}

function textIn(op: Op, block: Block, component: Registered, field: string): string {
  if (!component.fields.includes(field) || !Object.hasOwn(block.fields, field)) {
    refuse(op, 'unknown field');
  }
  return block.fields[field];
}

function withField(op: Op, block: Block, field: string, text: string): Block {
  if (!isCanonicalText(text)) refuse(op, 'text is not canonical');
  return { ...block, fields: { ...block.fields, [field]: text } };
}

function crossing(op: Op, from: string, to: string, text: string) {
  if (text !== '' && isRaw(from) !== isRaw(to)) {
    refuse(op, 'text cannot move between raw source and plain text');
  }
}

function joining(op: Op, head: string, headText: string, tail: string, tailText: string) {
  if (isRaw(head) && isRaw(tail) && headText !== '' && tailText !== '') {
    refuse(op, 'raw source is never joined or cut');
  }
}

export function plan(view: DocView, input: unknown, registry: Registry = builtins): Planned {
  const op = toOp(input);
  return { op, ...planned(view, op, registry) };
}

function inserting(
  view: DocView,
  op: Extract<Op, { kind: 'insertBlock' }>,
  registry: Registry,
): { change: Change; inverse: Op } {
  if (op.parent !== null) refuse(op, 'unknown slot');
  const { block } = op;
  if (view.blocks.get(block.id) !== undefined) refuse(op, 'id taken');
  const component = componentOf(op, registry, block.type);
  const props = propsOf(op, component, block.props);
  const fields = fieldsFor(component, block.fields) ?? refuse(op, 'fields do not fit the type');
  if (!Number.isInteger(op.index) || op.index < 0 || op.index > view.ids.length) {
    refuse(op, 'index outside the list');
  }
  const ids = [...view.ids];
  ids.splice(op.index, 0, block.id);
  return {
    change: { put: [{ id: block.id, type: block.type, props, fields }], ids, drop: [] },
    inverse: { kind: 'removeBlock', blockId: block.id },
  };
}

function planned(view: DocView, op: Op, registry: Registry): { change: Change; inverse: Op } {
  if (op.kind === 'insertBlock') return inserting(view, op, registry);
  const { blockId } = op;
  const block = view.blocks.get(blockId) ?? refuse(op, 'unknown block');
  const component = componentOf(op, registry, block.type);
  switch (op.kind) {
    case 'insertText': {
      const { field } = op;
      const text = textIn(op, block, component, field);
      const offset = offsetIn(op, text, op.offset);
      if (op.text === '') refuse(op, 'nothing to insert');
      const next = text.slice(0, offset) + op.text + text.slice(offset);
      return {
        change: { put: [withField(op, block, field, next)], drop: [] },
        inverse: { kind: 'deleteText', blockId, field, from: offset, to: offset + op.text.length },
      };
    }
    case 'deleteText': {
      const { field } = op;
      const text = textIn(op, block, component, field);
      const from = offsetIn(op, text, op.from);
      const to = offsetIn(op, text, op.to);
      if (from >= to) refuse(op, 'empty range');
      const next = text.slice(0, from) + text.slice(to);
      return {
        change: { put: [withField(op, block, field, next)], drop: [] },
        inverse: { kind: 'insertText', blockId, field, offset: from, text: text.slice(from, to) },
      };
    }
    case 'splitBlock': {
      const field = soleField(op, component);
      if (op.field !== field) refuse(op, 'unknown field');
      const text = textIn(op, block, component, field);
      const offset = offsetIn(op, text, op.offset);
      if (view.blocks.get(op.newId) !== undefined) refuse(op, 'id taken');
      const target = componentOf(op, registry, op.type);
      const targetField = soleField(op, target);
      const props = propsOf(op, target, op.props);
      const head = text.slice(0, offset);
      const tail = text.slice(offset);
      crossing(op, block.type, op.type, tail);
      joining(op, block.type, head, op.type, tail);
      const added: Block = { id: op.newId, type: op.type, props, fields: { [targetField]: tail } };
      const ids = [...view.ids];
      ids.splice(ids.indexOf(blockId) + 1, 0, op.newId);
      return {
        change: { put: [withField(op, block, field, head), added], ids, drop: [] },
        inverse: { kind: 'mergeBlocks', blockId: op.newId },
      };
    }
    case 'mergeBlocks': {
      const previousId = view.ids[view.ids.indexOf(blockId) - 1];
      const previous = previousId === undefined ? undefined : view.blocks.get(previousId);
      if (previous === undefined) refuse(op, 'no block before');
      const text = textIn(op, block, component, soleField(op, component));
      const before = componentOf(op, registry, previous.type);
      const field = soleField(op, before);
      const head = textIn(op, previous, before, field);
      crossing(op, block.type, previous.type, text);
      joining(op, previous.type, head, block.type, text);
      return {
        change: {
          put: [withField(op, previous, field, head + text)],
          ids: view.ids.filter((id) => id !== blockId),
          drop: [blockId],
        },
        inverse: {
          kind: 'splitBlock',
          blockId: previous.id,
          field,
          offset: head.length,
          newId: blockId,
          type: block.type,
          props: block.props,
        },
      };
    }
    case 'setType': {
      const target = componentOf(op, registry, op.type);
      const props = propsOf(op, target, op.props);
      if (op.type === block.type && sameJson(props, block.props)) {
        refuse(op, 'block already has that type');
      }
      const texts = Object.entries(block.fields);
      if (texts.some(([name, text]) => text !== '' && !target.fields.includes(name))) {
        refuse(op, 'the new type has no field for its text');
      }
      crossing(op, block.type, op.type, texts.map(([, text]) => text).join(''));
      const fields = Object.fromEntries(
        target.fields.map((name) => [
          name,
          Object.hasOwn(block.fields, name) ? block.fields[name] : '',
        ]),
      );
      return {
        change: { put: [{ id: blockId, type: op.type, props, fields }], drop: [] },
        inverse: { kind: 'setType', blockId, type: block.type, props: block.props },
      };
    }
    case 'setProps': {
      const props = propsOf(op, component, op.props);
      if (sameJson(props, block.props)) refuse(op, 'block already has those props');
      return {
        change: { put: [{ ...block, props }], drop: [] },
        inverse: { kind: 'setProps', blockId, props: block.props },
      };
    }
    case 'removeBlock':
      if (view.ids.length <= 1) refuse(op, 'the last block stays');
      return {
        change: { put: [], ids: view.ids.filter((id) => id !== blockId), drop: [blockId] },
        inverse: { kind: 'insertBlock', block, parent: null, index: view.ids.indexOf(blockId) },
      };
  }
}

export function planAll(view: DocView, inputs: readonly unknown[], registry: Registry): Planned[] {
  if (inputs.length === 0) throw new RangeError('dispatch refused: no ops');
  const blocks = new Map<BlockId, Block | undefined>();
  let ids = view.ids;
  const working: DocView = {
    get ids() {
      return ids;
    },
    blocks: { get: (id) => (blocks.has(id) ? blocks.get(id) : view.blocks.get(id)) },
  };
  const steps = inputs.map((input) => {
    const step = plan(working, input, registry);
    for (const id of step.change.drop) blocks.set(id, undefined);
    for (const block of step.change.put) blocks.set(block.id, block);
    ids = step.change.ids ?? ids;
    return step;
  });
  for (const [id, after] of blocks) {
    const before = view.blocks.get(id);
    if (before === undefined || after === undefined || isRaw(before.type) === isRaw(after.type)) {
      continue;
    }
    if (textOf(before) !== '' && textOf(after) !== '') {
      throw new RangeError('dispatch refused: text cannot move between raw source and plain text');
    }
  }
  return steps;
}

function textOf(block: Block): string {
  return Object.values(block.fields).join('');
}

export function apply(doc: Doc, op: Op, registry: Registry = builtins): { doc: Doc; inverse: Op } {
  const { change, inverse } = plan(doc, op, registry);
  const blocks = new Map(doc.blocks);
  for (const id of change.drop) blocks.delete(id);
  for (const block of change.put) blocks.set(block.id, block);
  return { doc: { ids: change.ids ?? doc.ids, blocks, sources: doc.sources }, inverse };
}
