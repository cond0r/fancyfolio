import { placeOf } from '../core/ops.ts';
import type { Bare, BlockId, Commands, DocView, Editor, Selection } from '../core/types.ts';
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

function textIn(editor: Editor, blockId: BlockId, name: string): string {
  const block = editor.blocks.get(blockId);
  return block === undefined ? '' : (editor.store.get(block).fields[name] ?? '');
}

export function renderText(field: HTMLElement, text: string): void {
  const broken = text === '' || text.endsWith('\n');
  const nodes = [...field.childNodes];
  const wanted = (text === '' ? 0 : 1) + (broken ? 1 : 0);
  const [first] = nodes;
  const textOk = text === '' || (first instanceof Text && first.data === text);
  const breakOk = !broken || nodes.at(-1)?.nodeName === 'BR';
  if (nodes.length === wanted && textOk && breakOk) return;
  const line = field.ownerDocument.createElement('br');
  field.replaceChildren(...(text === '' ? [] : [text]), ...(broken ? [line] : []));
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
  const show = () => renderText(field, editor.store.get(block).fields[name] ?? '');
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

export function bindEditor(root: HTMLElement, editor: Editor): () => void {
  const { store } = editor;
  const document = root.ownerDocument;
  let composing: Selection | undefined;
  let anchor: BlockId | undefined;
  let spanning = false;

  const select = (selection: Selection) => {
    const before = store.get(editor.selection);
    if (sameSelection(before, selection)) return false;
    store.set(editor.selection, selection);
    return true;
  };

  const inFieldOrBlockSelection = (node: EventTarget | null) =>
    node === root || (node instanceof Node && fieldOf(node) !== undefined);

  const sync = () => {
    if (composing !== undefined || spanning) return;
    const read = readSelection(root);
    if (read !== undefined) select(read);
  };

  const run = <C extends keyof Commands>(name: C, args: Commands[C]) => {
    editor.command(name, args);
    place(root, store.get(editor.selection));
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
    if (inputType === 'insertText' || inputType === 'insertReplacementText') {
      if (inputType === 'insertReplacementText' && target(event) === undefined) return;
      return run('insertText', {
        text: event.data ?? event.dataTransfer?.getData('text/plain') ?? '',
      });
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
    if (event.isComposing || composing !== undefined) return;
    const key = event.key.toLowerCase();
    const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
    if (mod && key === 's') {
      event.preventDefault();
      editor.save().catch((error: unknown) => console.error(error));
      return;
    }
    if (mod && (key === 'z' || key === 'y')) {
      event.preventDefault();
      return run(key === 'y' || event.shiftKey ? 'redo' : 'undo', {});
    }
    if (!inFieldOrBlockSelection(event.target)) return;
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
    if (event.data !== '') editor.command('insertText', { text: event.data });
    const field = event.target instanceof Node ? fieldOf(event.target) : undefined;
    if (field !== undefined && before.kind === 'text') {
      renderText(field, textIn(editor, before.blockId, before.field));
    }
    place(root, store.get(editor.selection));
  };

  const span = (from: BlockId, to: BlockId) => {
    const ids = spanOf(editor.doc(), from, to);
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
