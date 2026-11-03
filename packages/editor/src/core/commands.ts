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

const none = () => undefined;

const defaults: DefaultHandlers = {
  insertText: none,
  insertBreak(context) {
    const at = textAt(context);
    if (at === undefined || soleField(at.block) !== at.field) return undefined;
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
  deleteBackward: none,
  deleteForward: none,
  deleteSelection: none,
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
