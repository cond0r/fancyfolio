import {
  coverage,
  covered,
  deleted,
  inserted,
  isMarkType,
  marksFor,
  marksIn,
  shifted,
  sliced,
  withMarks,
} from './marks.ts';
import { isCanonicalText, isRaw, isRecord, jsonOf, sameJson } from './model.ts';
import { builtins, fieldsFor, propsFor } from './registry.ts';
import { placeOf, relinked, viewOf } from './tree.ts';
import type {
  Block,
  BlockId,
  Change,
  Doc,
  DocView,
  Fail,
  Json,
  Mark,
  Marks,
  Op,
  Parent,
  Place,
  Planned,
  Position,
  Registered,
  Registry,
  Slots,
  Span,
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

function slotsFrom(input: unknown): Slots | undefined {
  if (!isRecord(input)) return undefined;
  const entries: [string, readonly BlockId[]][] = [];
  for (const [name, ids] of Object.entries(input)) {
    if (!Array.isArray(ids) || !ids.every(isId)) return undefined;
    entries.push([name, Object.freeze([...ids])]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function spanFrom(input: unknown): Span | undefined {
  const from = field(input, 'from');
  const to = field(input, 'to');
  const href = field(input, 'href');
  if (typeof from !== 'number' || typeof to !== 'number') return undefined;
  if (href === undefined) return Object.freeze({ from, to });
  return typeof href === 'string' ? Object.freeze({ from, to, href }) : undefined;
}

function listFrom<T>(
  input: unknown,
  each: (item: unknown) => T | undefined,
): readonly T[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const items: T[] = [];
  for (const item of input) {
    const parsed = each(item);
    if (parsed === undefined) return undefined;
    items.push(parsed);
  }
  return Object.freeze(items);
}

function markFrom(input: unknown): Mark | undefined {
  const type = field(input, 'type');
  const span = spanFrom(input);
  return typeof type === 'string' && isMarkType(type) && span !== undefined
    ? Object.freeze({ type, ...span })
    : undefined;
}

function marksFrom(input: unknown): Marks | undefined {
  if (!isRecord(input)) return undefined;
  const entries: [string, readonly Mark[]][] = [];
  for (const [name, list] of Object.entries(input)) {
    const marks = listFrom(list, markFrom);
    if (marks === undefined) return undefined;
    entries.push([name, marks]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function blockFrom(input: unknown): Block | undefined {
  const id = field(input, 'id');
  const type = field(input, 'type');
  const props = jsonOf(field(input, 'props'));
  const fields = field(input, 'fields');
  const listed = field(input, 'slots');
  const slots = listed === undefined ? undefined : slotsFrom(listed);
  const given = field(input, 'marks');
  const marks = given === undefined ? undefined : marksFrom(given);
  if (!isId(id) || typeof type !== 'string' || props === undefined || !isRecord(fields)) {
    return undefined;
  }
  if (listed !== undefined && slots === undefined) return undefined;
  if (given !== undefined && marks === undefined) return undefined;
  const entries: [string, string][] = [];
  for (const [name, text] of Object.entries(fields)) {
    if (typeof text !== 'string') return undefined;
    entries.push([name, text]);
  }
  const block = { id, type, props, fields: Object.freeze(Object.fromEntries(entries)) };
  return Object.freeze({ ...block, ...(marks && { marks }), ...(slots && { slots }) });
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
      const given = field(input, 'marks');
      const marks = given === undefined ? undefined : listFrom(given, markFrom);
      if (given !== undefined && marks === undefined) return undefined;
      return typeof fieldName === 'string' && typeof offset === 'number' && typeof text === 'string'
        ? { kind, blockId, field: fieldName, offset, text, ...(marks && { marks }) }
        : undefined;
    }
    case 'markText': {
      const fieldName = field(input, 'field');
      const mark = field(input, 'mark');
      const from = field(input, 'from');
      const to = field(input, 'to');
      const spans = listFrom(field(input, 'spans'), spanFrom);
      return typeof fieldName === 'string' &&
        typeof mark === 'string' &&
        isMarkType(mark) &&
        typeof from === 'number' &&
        typeof to === 'number' &&
        spans !== undefined
        ? { kind, blockId, field: fieldName, mark, from, to, spans }
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
    case 'moveBlock': {
      const parent = parentFrom(field(input, 'parent'));
      const index = field(input, 'index');
      return parent !== undefined && typeof index === 'number'
        ? { kind, blockId, parent, index }
        : undefined;
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

function componentOf(op: Op, registry: Registry, type: string): Registered {
  return registry.components.get(type) ?? refuse(op, 'unknown block type');
}

function propsOf(op: Op, component: Registered, props: unknown): Json {
  return propsFor(component, props) ?? refuse(op, 'props fail the schema');
}

function soleField(op: Op, component: Registered): string {
  if (hasSlots(component)) refuse(op, 'the block has slots');
  const [only, ...rest] = component.fields;
  if (only === undefined || rest.length > 0) refuse(op, 'the block has more than one field');
  return only;
}

function hasSlots(component: Registered): boolean {
  return (component.slots ?? []).length > 0;
}

function fitsSlot(op: Op, component: Registered) {
  if (hasSlots(component)) refuse(op, 'a slot child has no slots');
  if (component.markdown === undefined) refuse(op, 'raw source stays at the top level');
}

function slotsFor(op: Op, component: Registered, slots: Slots | undefined): Slots | undefined {
  const names = component.slots ?? [];
  if (names.length === 0 && slots === undefined) return undefined;
  const fresh =
    slots !== undefined &&
    Object.keys(slots).length === names.length &&
    names.every((name) => Object.hasOwn(slots, name) && slots[name]?.length === 0);
  if (names.length === 0 || !fresh) refuse(op, 'slots start empty');
  return Object.fromEntries(names.map((name) => [name, []]));
}

function placed(op: Op, view: DocView, blockId: BlockId): Place {
  return placeOf(view, blockId) ?? refuse(op, 'the block is in no list');
}

function relisted(
  view: Pick<DocView, 'ids' | 'blocks'>,
  { parent }: Pick<Place, 'parent'>,
  list: readonly BlockId[],
): { put: Block[]; ids?: readonly BlockId[] } {
  if (parent === null) return { put: [], ids: list };
  const owner = view.blocks.get(parent.blockId);
  if (owner === undefined) throw new Error(`block ${parent.blockId} is missing`);
  return { put: [{ ...owner, slots: { ...owner.slots, [parent.slot]: list } }] };
}

function listIn(op: Op, view: Pick<DocView, 'ids' | 'blocks'>, parent: Parent): readonly BlockId[] {
  if (parent === null) return view.ids;
  const owner = view.blocks.get(parent.blockId);
  if (owner?.slots === undefined || !Object.hasOwn(owner.slots, parent.slot)) {
    refuse(op, 'unknown slot');
  }
  return owner.slots[parent.slot];
}

function putAt(op: Op, list: readonly BlockId[], index: number, id: BlockId): BlockId[] {
  if (!Number.isInteger(index) || index < 0 || index > list.length) {
    refuse(op, 'index outside the list');
  }
  return list.toSpliced(index, 0, id);
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

export function movable(from: string, to: string, kept: string, moved: string): boolean {
  if (moved === '' || (!isRaw(from) && !isRaw(to))) return true;
  return isRaw(from) && isRaw(to) && kept === '';
}

function moving(op: Op, from: string, to: string, kept: string, moved: string) {
  if (movable(from, to, kept, moved)) return;
  if (isRaw(from) === isRaw(to)) refuse(op, 'raw source is never joined or cut');
  refuse(op, 'text cannot move between raw source and plain text');
}

export function plan(
  view: DocView,
  input: unknown,
  registry: Registry = builtins,
  raw = false,
): Planned {
  const op = toOp(input);
  return { op, ...planned(view, op, registry, raw) };
}

function failing(op: Op, raw: boolean): Fail | undefined {
  return raw ? undefined : (reason) => refuse(op, reason);
}

function marking(
  registry: Registry,
  component: Registered,
  block: Block,
  fields: Block['fields'],
  marks: Marks,
  fail: Fail | undefined,
): Block {
  let made = block;
  for (const [name, list] of Object.entries(marks)) {
    const text = Object.hasOwn(fields, name) ? fields[name] : '';
    made = withMarks(made, name, marksFor(registry, component, name, text, list, fail));
  }
  return made;
}

function inserting(
  view: DocView,
  op: Extract<Op, { kind: 'insertBlock' }>,
  registry: Registry,
  raw: boolean,
): { change: Change; inverse: Op } {
  const { block, parent } = op;
  if (view.blocks.get(block.id) !== undefined) refuse(op, 'id taken');
  const component = componentOf(op, registry, block.type);
  const props = propsOf(op, component, block.props);
  const fields = fieldsFor(component, block.fields) ?? refuse(op, 'fields do not fit the type');
  const slots = slotsFor(op, component, block.slots);
  const list = listIn(op, view, parent);
  if (parent !== null) fitsSlot(op, component);
  const next = putAt(op, list, op.index, block.id);
  const bare: Block = { id: block.id, type: block.type, props, fields, ...(slots && { slots }) };
  const made = marking(registry, component, bare, fields, block.marks ?? {}, failing(op, raw));
  const { put, ids } = relisted(view, { parent }, next);
  return {
    change: { put: [made, ...put], ids, drop: [] },
    inverse: { kind: 'removeBlock', blockId: block.id },
  };
}

function planned(
  view: DocView,
  op: Op,
  registry: Registry,
  raw: boolean,
): { change: Change; inverse: Op } {
  if (op.kind === 'insertBlock') return inserting(view, op, registry, raw);
  const { blockId } = op;
  const block = view.blocks.get(blockId) ?? refuse(op, 'unknown block');
  const component = componentOf(op, registry, block.type);
  const fail = failing(op, raw);
  const remarked = (into: Block, field: string, text: string, marks: readonly Mark[]) =>
    withMarks(into, field, marksFor(registry, component, field, text, marks, fail));
  switch (op.kind) {
    case 'insertText': {
      const { field } = op;
      const text = textIn(op, block, component, field);
      const offset = offsetIn(op, text, op.offset);
      if (op.text === '') refuse(op, 'nothing to insert');
      const next = text.slice(0, offset) + op.text + text.slice(offset);
      const added = marksFor(registry, component, field, op.text, op.marks ?? [], fail);
      const marks = inserted(marksIn(block, field), offset, op.text.length, added);
      return {
        change: {
          put: [remarked(withField(op, block, field, next), field, next, marks)],
          drop: [],
        },
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
      const old = marksIn(block, field);
      const cut = sliced(old, from, to);
      const marks = deleted(old, from, to);
      return {
        change: {
          put: [remarked(withField(op, block, field, next), field, next, marks)],
          drop: [],
        },
        inverse: {
          kind: 'insertText',
          blockId,
          field,
          offset: from,
          text: text.slice(from, to),
          ...(cut.length > 0 && { marks: cut }),
        },
      };
    }
    case 'markText': {
      const { field, mark } = op;
      const text = textIn(op, block, component, field);
      const from = offsetIn(op, text, op.from);
      const to = offsetIn(op, text, op.to);
      if (from >= to) refuse(op, 'empty range');
      const spans = op.spans.filter((span) => {
        const inside = span.from >= from && span.to <= to;
        if (!inside) fail?.('span outside the range');
        return inside;
      });
      const old = marksIn(block, field);
      return {
        change: {
          put: [remarked(block, field, text, covered(old, mark, from, to, spans))],
          drop: [],
        },
        inverse: {
          kind: 'markText',
          blockId,
          field,
          mark,
          from,
          to,
          spans: coverage(old, mark, from, to),
        },
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
      moving(op, block.type, op.type, head, tail);
      const place = placed(op, view, blockId);
      if (place.parent !== null) fitsSlot(op, target);
      const fields = { [targetField]: tail };
      const bare: Block = { id: op.newId, type: op.type, props, fields };
      const old = marksIn(block, field);
      const moved = { [targetField]: sliced(old, offset, text.length) };
      const added = marking(registry, target, bare, fields, moved, fail);
      const kept = remarked(withField(op, block, field, head), field, head, sliced(old, 0, offset));
      const list = place.list.toSpliced(place.index + 1, 0, op.newId);
      const { put, ids } = relisted(view, place, list);
      return {
        change: { put: [kept, added, ...put], ids, drop: [] },
        inverse: { kind: 'mergeBlocks', blockId: op.newId },
      };
    }
    case 'mergeBlocks': {
      const own = soleField(op, component);
      const text = textIn(op, block, component, own);
      const place = placed(op, view, blockId);
      const previousId = place.list[place.index - 1];
      const previous = previousId === undefined ? undefined : view.blocks.get(previousId);
      if (previous === undefined) refuse(op, 'no block before');
      const before = componentOf(op, registry, previous.type);
      const field = soleField(op, before);
      const head = textIn(op, previous, before, field);
      moving(op, block.type, previous.type, head, text);
      const joined = [...marksIn(previous, field), ...shifted(marksIn(block, own), head.length)];
      const merged = withField(op, previous, field, head + text);
      const marks = marksFor(registry, before, field, head + text, joined, fail);
      const relist = relisted(
        view,
        place,
        place.list.filter((id) => id !== blockId),
      );
      return {
        change: {
          put: [withMarks(merged, field, marks), ...relist.put],
          ids: relist.ids,
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
      if (!view.ids.includes(blockId)) fitsSlot(op, target);
      const props = propsOf(op, target, op.props);
      if (op.type === block.type && sameJson(props, block.props)) {
        refuse(op, 'block already has that type');
      }
      const texts = Object.entries(block.fields);
      if (!raw && texts.some(([name, text]) => text !== '' && !target.fields.includes(name))) {
        refuse(op, 'the new type has no field for its text');
      }
      const fields = Object.fromEntries(
        target.fields.map((name) => [
          name,
          Object.hasOwn(block.fields, name) ? block.fields[name] : '',
        ]),
      );
      moving(op, block.type, op.type, '', Object.values(fields).join(''));
      const kept = block.slots ?? {};
      const names = target.slots ?? [];
      const orphans = Object.entries(kept).flatMap(([name, ids]) =>
        names.includes(name) ? [] : ids,
      );
      if (!raw && orphans.length > 0) refuse(op, 'the new type has no slot for its blocks');
      const slots = Object.fromEntries(
        names.map((name) => [name, Object.hasOwn(kept, name) ? kept[name] : []]),
      );
      const bare: Block = { id: blockId, type: op.type, props, fields };
      const made = marking(registry, target, bare, fields, block.marks ?? {}, fail);
      const at = view.ids.indexOf(blockId) + 1;
      return {
        change: {
          put: [names.length > 0 ? { ...made, slots } : made],
          ...(orphans.length > 0 && { ids: view.ids.toSpliced(at, 0, ...orphans) }),
          drop: [],
        },
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
    case 'removeBlock': {
      if (Object.values(block.slots ?? {}).some((ids) => ids.length > 0)) {
        refuse(op, 'a container with children stays');
      }
      const place = placed(op, view, blockId);
      if (!raw && place.parent === null && place.list.length <= 1) {
        refuse(op, 'the last block stays');
      }
      const { put, ids } = relisted(
        view,
        place,
        place.list.filter((id) => id !== blockId),
      );
      return {
        change: { put, ids, drop: [blockId] },
        inverse: {
          kind: 'insertBlock',
          block,
          parent: place.parent,
          index: place.index,
        },
      };
    }
    case 'moveBlock': {
      const from = placed(op, view, blockId);
      const left = relisted(
        view,
        from,
        from.list.filter((id) => id !== blockId),
      );
      const out: Pick<DocView, 'ids' | 'blocks'> = {
        ids: left.ids ?? view.ids,
        blocks: { get: (id) => left.put.find((each) => each.id === id) ?? view.blocks.get(id) },
      };
      const list = listIn(op, out, op.parent);
      if (op.parent !== null) fitsSlot(op, component);
      const into = relisted(out, { parent: op.parent }, putAt(op, list, op.index, blockId));
      const owners = new Set(into.put.map((each) => each.id));
      return {
        change: {
          put: [...left.put.filter((each) => !owners.has(each.id)), ...into.put],
          ids: into.ids ?? left.ids,
          drop: [],
        },
        inverse: {
          kind: 'moveBlock',
          blockId,
          parent: from.parent,
          index: from.index,
        },
      };
    }
  }
}

export function mapThrough(op: Op, position: Position, bias: -1 | 1 = -1): Position | undefined {
  return mapIn(builtins, op, position, bias);
}

export function mapIn(
  registry: Registry,
  op: Op,
  position: Position,
  bias: -1 | 1 = -1,
): Position | undefined {
  if (!('blockId' in op) || op.blockId !== position.blockId) return position;
  const { field, offset } = position;
  switch (op.kind) {
    case 'removeBlock':
      return undefined;
    case 'setType':
      return registry.components.get(op.type)?.fields.includes(field) ? position : undefined;
    case 'insertText': {
      const pushed = op.offset < offset || (op.offset === offset && bias > 0);
      return op.field === field && pushed
        ? { ...position, offset: offset + op.text.length }
        : position;
    }
    case 'deleteText':
      return op.field === field && op.from < offset
        ? { ...position, offset: Math.max(op.from, offset - (op.to - op.from)) }
        : position;
    default:
      return position;
  }
}

export function emptyParagraph(id: BlockId): Block {
  return { id, type: 'paragraph', props: {}, fields: { text: '' } };
}

export function planAll(
  view: DocView,
  inputs: readonly unknown[],
  registry: Registry,
  newId?: () => BlockId,
): Planned[] {
  if (inputs.length === 0) throw new RangeError('dispatch refused: no ops');
  const blocks = new Map<BlockId, Block | undefined>();
  const parents = new Map<BlockId, Parent | undefined>();
  let ids = view.ids;
  const working: DocView = {
    get ids() {
      return ids;
    },
    blocks: { get: (id) => (blocks.has(id) ? blocks.get(id) : view.blocks.get(id)) },
    parentOf: (id) => (parents.has(id) ? parents.get(id) : view.parentOf(id)),
  };
  const planOne = (input: unknown) => {
    const step = plan(working, input, registry, newId === undefined);
    for (const [id, parent] of relinked(working, step.change)) parents.set(id, parent);
    for (const id of step.change.drop) blocks.set(id, undefined);
    for (const block of step.change.put) blocks.set(block.id, block);
    ids = step.change.ids ?? ids;
    return step;
  };
  const steps = inputs.map(planOne);
  const originals = newId === undefined ? [] : [...steps];
  for (const { op } of originals) {
    for (const { transform } of registry.components.values()) {
      if (transform !== undefined) steps.push(...transform(op, working).map(planOne));
    }
  }
  if (newId !== undefined) {
    for (const parent of emptied(view, blocks)) {
      steps.push(
        planOne({ kind: 'insertBlock', block: emptyParagraph(newId()), parent, index: 0 }),
      );
    }
  }
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

function emptied(view: DocView, changed: ReadonlyMap<BlockId, Block | undefined>): Parent[] {
  return [...changed].flatMap(([blockId, after]) => {
    const before = view.blocks.get(blockId);
    return Object.entries(after?.slots ?? {}).flatMap(([slot, list]) =>
      before !== undefined && list.length === 0 && (before.slots?.[slot]?.length ?? 1) > 0
        ? [{ blockId, slot }]
        : [],
    );
  });
}

function textOf(block: Block): string {
  return Object.values(block.fields).join('');
}

export function apply(doc: Doc, op: Op, registry: Registry = builtins): { doc: Doc; inverse: Op } {
  const { change, inverse } = plan(viewOf(doc), op, registry);
  const blocks = new Map(doc.blocks);
  for (const id of change.drop) blocks.delete(id);
  for (const block of change.put) blocks.set(block.id, block);
  return { doc: { ids: change.ids ?? doc.ids, blocks, sources: doc.sources }, inverse };
}
