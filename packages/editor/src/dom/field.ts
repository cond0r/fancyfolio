import { marksIn, typedMarks } from '../core/marks.ts';
import { sameJson } from '../core/model.ts';
import { placeOf } from '../core/tree.ts';
import type {
  Bare,
  Block,
  BlockId,
  Commands,
  DocView,
  Editor,
  Mark,
  MarkType,
  Selection,
  TextSelection,
} from '../core/types.ts';
import {
  blockOf,
  fieldElement,
  fieldOf,
  offsetAtPoint,
  onEdgeLine,
  place,
  readSelection,
  sameSelection,
  textRange,
} from './selection.ts';

const bare = new Map<string, Bare>([
  ['insertParagraph', 'insertBreak'],
  ['insertLineBreak', 'insertBreak'],
  ['deleteContentBackward', 'deleteBackward'],
  ['deleteContentForward', 'deleteForward'],
  ['historyUndo', 'undo'],
  ['historyRedo', 'redo'],
]);

const arrows = new Map<string, -1 | 1>([
  ['ArrowLeft', -1],
  ['ArrowUp', -1],
  ['ArrowRight', 1],
  ['ArrowDown', 1],
]);

const formats = new Map<string, MarkType>([
  ['formatBold', 'bold'],
  ['formatItalic', 'italic'],
  ['formatStrikeThrough', 'strike'],
]);

const keys = new Map<string, MarkType>([
  ['b', 'bold'],
  ['i', 'italic'],
  ['e', 'code'],
]);

const nesting: readonly MarkType[] = ['link', 'bold', 'italic', 'strike', 'code'];

const tags = {
  link: 'span',
  bold: 'strong',
  italic: 'em',
  strike: 's',
  code: 'code',
} as const satisfies Record<MarkType, string>;

function blockIn(editor: Editor, blockId: BlockId): Block | undefined {
  const block = editor.blocks.get(blockId);
  return block === undefined ? undefined : editor.store.get(block);
}

function textIn(editor: Editor, blockId: BlockId, name: string): string {
  return blockIn(editor, blockId)?.fields[name] ?? '';
}

function markKey(event: KeyboardEvent): MarkType | undefined {
  const key = event.key.toLowerCase();
  return event.shiftKey ? (key === 'x' ? 'strike' : undefined) : keys.get(key);
}

function pendingMarks(
  block: Block | undefined,
  { field, from }: TextSelection,
  text: string,
  pending: ReadonlyMap<MarkType, boolean>,
): Mark[] {
  const typed = block === undefined ? [] : typedMarks(block, field, from, text);
  const kept = typed.filter(({ type }) => pending.get(type) !== false);
  const added = [...pending]
    .filter(([type, on]) => on && !kept.some((mark) => mark.type === type))
    .map(([type]) => ({ type, from: 0, to: text.length }));
  return [...kept, ...added];
}

const shown = new WeakMap<HTMLElement, readonly [string, readonly Mark[]]>();

function renderField(field: HTMLElement, block: Block | undefined, name: string): void {
  const text = block?.fields[name] ?? '';
  const marks = block === undefined ? [] : marksIn(block, name);
  const last = shown.get(field);
  if (last !== undefined && last[0] === text && sameJson(last[1], marks)) return;
  shown.set(field, [text, marks]);
  const document = field.ownerDocument;
  const top = document.createDocumentFragment();
  const cuts = [...new Set([0, text.length, ...marks.flatMap(({ from, to }) => [from, to])])];
  cuts.sort((a, b) => a - b);
  let open: { mark: Mark; element: HTMLElement }[] = [];
  let from = 0;
  for (const to of cuts.slice(1)) {
    const wanted = nesting.flatMap((type) =>
      marks.filter((mark) => mark.type === type && mark.from <= from && to <= mark.to),
    );
    let depth = 0;
    while (depth < open.length && open[depth]?.mark === wanted[depth]) depth += 1;
    open = open.slice(0, depth);
    for (const mark of wanted.slice(depth)) {
      const element = document.createElement(tags[mark.type]);
      if (mark.type === 'link') element.dataset.ffLink = '';
      (open.at(-1)?.element ?? top).append(element);
      open.push({ mark, element });
    }
    (open.at(-1)?.element ?? top).append(text.slice(from, to));
    from = to;
  }
  if (text === '' || text.endsWith('\n')) top.append(document.createElement('br'));
  field.replaceChildren(top);
}

export function spanOf(view: DocView, from: BlockId, to: BlockId): BlockId[] | undefined {
  const { ids } = view;
  const at = (id: BlockId) => ids.indexOf(placeOf(view, id)?.parent?.blockId ?? id);
  const [start, end] = [at(from), at(to)].sort((a, b) => a - b);
  if (start === undefined || end === undefined || start < 0) return undefined;
  return ids.slice(start, end + 1);
}

export function bindField(field: HTMLElement, editor: Editor, blockId: BlockId, name: string) {
  const block = editor.blocks.get(blockId);
  if (block === undefined) throw new Error(`block ${blockId} has no atom`);
  field.style.whiteSpace = 'pre-wrap';
  const show = () => {
    const current = editor.store.get(block);
    renderField(field, current, name);
    field.toggleAttribute('data-empty', (current.fields[name] ?? '') === '');
  };
  show();
  const root = field.closest<HTMLElement>('[data-ff-editor]');
  const selection = editor.store.get(editor.selection);
  const focused = root?.contains(field.ownerDocument.activeElement) ?? false;
  const mine = selection.kind === 'text' && selection.blockId === blockId;
  if (root !== null && focused && mine && selection.field === name) place(root, selection);
  return editor.store.sub(block, show);
}

export function deleteBlock(root: HTMLElement, editor: Editor, blockId: BlockId): void {
  const { store } = editor;
  const before = store.get(editor.selection);
  store.set(editor.selection, { kind: 'blocks', ids: [blockId] });
  if (editor.command('deleteSelection', {})) place(root, store.get(editor.selection));
  else store.set(editor.selection, before);
}

export function editsIn(root: HTMLElement, node: EventTarget | null): boolean {
  return node === root || (node instanceof Node && fieldOf(node) !== undefined);
}

export function saveOn(event: KeyboardEvent, editor: Editor): boolean {
  const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
  if (!mod || event.key.toLowerCase() !== 's') return false;
  event.preventDefault();
  editor.save().catch((error: unknown) => console.error(error));
  return true;
}

export function bindEditor(root: HTMLElement, editor: Editor): () => void {
  const { store } = editor;
  const document = root.ownerDocument;
  let composing: Selection | undefined;
  let anchor: BlockId | undefined;
  let spanning = false;
  let pending: { at: TextSelection; marks: ReadonlyMap<MarkType, boolean> } | undefined;

  const select = (selection: Selection) => {
    const before = store.get(editor.selection);
    if (sameSelection(before, selection)) return false;
    pending = undefined;
    store.set(editor.selection, selection);
    return true;
  };

  const pendingAt = (at: Selection) =>
    at.kind === 'text' && pending !== undefined && sameSelection(pending.at, at)
      ? pending.marks
      : undefined;

  const run = <C extends keyof Commands>(name: C, args: Commands[C]) => {
    editor.command(name, args);
    place(root, store.get(editor.selection));
  };

  const insert = (text: string) => {
    const at = store.get(editor.selection);
    const marks = pendingAt(at);
    if (marks === undefined || at.kind !== 'text') {
      editor.command('insertText', { text });
      return;
    }
    editor.command('insertText', {
      text,
      marks: pendingMarks(blockIn(editor, at.blockId), at, text, marks),
    });
    const after = store.get(editor.selection);
    if (after.kind === 'text') pending = { at: after, marks };
  };

  const format = (mark: MarkType) => {
    const at = store.get(editor.selection);
    if (at.kind !== 'text') return;
    if (at.from < at.to) return run('toggleMark', { mark });
    const block = blockIn(editor, at.blockId);
    const before = pendingAt(at) ?? new Map<MarkType, boolean>();
    const on = pendingMarks(block, at, 'x', before).some((each) => each.type === mark);
    const marks = new Map([...before, [mark, !on]]);
    const accepted = editor.can('insertText', {
      text: 'x',
      marks: pendingMarks(block, at, 'x', marks),
    });
    if (accepted) pending = { at, marks };
  };

  const inFieldOrBlockSelection = (node: EventTarget | null) => editsIn(root, node);

  const sync = () => {
    if (composing !== undefined || spanning) return;
    const read = readSelection(root);
    if (read !== undefined) select(read);
  };

  const target = (event: InputEvent) => {
    const [range] = event.getTargetRanges();
    const selection = range === undefined ? undefined : textRange(root, range);
    if (selection !== undefined) select(selection);
    return selection;
  };

  const onBeforeInput = (event: InputEvent) => {
    if (!inFieldOrBlockSelection(event.target)) return;
    const { inputType } = event;
    if (inputType.includes('Composition')) {
      if (composing === undefined && event.cancelable) event.preventDefault();
      return;
    }
    event.preventDefault();
    // WebKit fires beforeinput at the selected field while focus sits on a chrome control.
    if (!inFieldOrBlockSelection(document.activeElement)) return;
    sync();
    const command = bare.get(inputType);
    if (command !== undefined) return run(command, {});
    const mark = formats.get(inputType);
    if (mark !== undefined) return format(mark);
    if (inputType === 'insertText' || inputType === 'insertReplacementText') {
      if (inputType === 'insertReplacementText' && target(event) === undefined) return;
      insert(event.data ?? event.dataTransfer?.getData('text/plain') ?? '');
      return place(root, store.get(editor.selection));
    }
    const range = inputType.startsWith('delete') ? target(event) : undefined;
    if (range !== undefined && range.from < range.to) run('deleteSelection', {});
  };

  const step = (event: KeyboardEvent, direction: -1 | 1) => {
    const at = readSelection(root);
    const field = at === undefined ? undefined : fieldElement(root, at.blockId, at.field);
    if (at === undefined || field === undefined || at.from !== at.to) return;
    const fields = [...root.querySelectorAll<HTMLElement>('[data-field]')];
    const next = fields[fields.indexOf(field) + direction];
    const blockId = blockOf(next ?? null);
    const name = next?.dataset.field;
    if (next === undefined || blockId === undefined || name === undefined) return;
    const length = textIn(editor, blockId, name).length;
    const end = direction < 0 ? length : 0;
    let offset = end;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (direction < 0 ? at.from > 0 : at.from < textIn(editor, at.blockId, at.field).length) {
        return;
      }
    } else {
      if (!onEdgeLine(field, direction)) return;
      const caret = document.getSelection()?.getRangeAt(0).getBoundingClientRect();
      const box = next.getBoundingClientRect();
      const y = direction < 0 ? box.bottom - 1 : box.top + 1;
      offset = (caret && offsetAtPoint(next, caret.left, y)) ?? end;
    }
    event.preventDefault();
    select({ kind: 'text', blockId, field: name, from: offset, to: offset });
    place(root, store.get(editor.selection));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || composing !== undefined) return;
    if (!inFieldOrBlockSelection(event.target)) return;
    if (saveOn(event, editor)) return;
    const key = event.key.toLowerCase();
    const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
    if (mod && (key === 'z' || key === 'y')) {
      event.preventDefault();
      return run(key === 'y' || event.shiftKey ? 'redo' : 'undo', {});
    }
    const mark = mod ? markKey(event) : undefined;
    if (mark !== undefined) {
      event.preventDefault();
      sync();
      return format(mark);
    }
    const modified = event.shiftKey || event.metaKey || event.ctrlKey || event.altKey;
    const deletion = event.key === 'Backspace' ? 'deleteBackward' : 'deleteForward';
    if ((event.key === 'Backspace' || event.key === 'Delete') && !modified) {
      event.preventDefault();
      sync();
      return run(deletion, {});
    }
    const direction = arrows.get(event.key);
    if (store.get(editor.selection).kind === 'blocks') return;
    if (direction !== undefined && !modified) step(event, direction);
  };

  const onCompositionStart = (event: CompositionEvent) => {
    if (!inFieldOrBlockSelection(event.target)) return;
    sync();
    composing = store.get(editor.selection);
  };

  const onCompositionEnd = (event: CompositionEvent) => {
    const before = composing;
    composing = undefined;
    if (before === undefined) return;
    store.set(editor.selection, before);
    if (event.data !== '') insert(event.data);
    const field = event.target instanceof Node ? fieldOf(event.target) : undefined;
    if (field !== undefined && before.kind === 'text') {
      shown.delete(field);
      renderField(field, blockIn(editor, before.blockId), before.field);
    }
    place(root, store.get(editor.selection));
  };

  const span = (from: BlockId, to: BlockId) => {
    const ids = spanOf(editor.view, from, to);
    if (ids !== undefined && select({ kind: 'blocks', ids })) {
      place(root, store.get(editor.selection));
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    spanning = false;
    anchor = event.target instanceof Node ? blockOf(event.target) : undefined;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (anchor === undefined || (event.buttons & 1) === 0) return;
    const id = event.target instanceof Node ? blockOf(event.target) : undefined;
    if (id === undefined || (id === anchor && !spanning)) return;
    spanning = true;
    span(anchor, id);
  };

  const onPointerUp = () => {
    if (spanning) place(root, store.get(editor.selection));
    anchor = undefined;
    spanning = false;
  };

  const controller = new AbortController();
  const options = { signal: controller.signal };
  root.addEventListener('beforeinput', onBeforeInput, options);
  root.addEventListener('keydown', onKeyDown, options);
  root.addEventListener('compositionstart', onCompositionStart, options);
  root.addEventListener('compositionend', onCompositionEnd, options);
  root.addEventListener('pointerdown', onPointerDown, options);
  root.addEventListener('pointermove', onPointerMove, options);
  document.addEventListener('pointerup', onPointerUp, options);
  document.addEventListener('selectionchange', sync, options);
  return () => controller.abort();
}
