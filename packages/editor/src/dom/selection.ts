import type { BlockId, Selection, TextSelection } from '../core/types.ts';

export function fieldOf(node: Node | null): HTMLElement | undefined {
  const element = node instanceof Element ? node : node?.parentElement;
  const field = element?.closest('[data-field]');
  return field instanceof HTMLElement ? field : undefined;
}

export function blockOf(node: Node | null): BlockId | undefined {
  const element = node instanceof Element ? node : node?.parentElement;
  const block = element?.closest('[data-block-id]');
  return block instanceof HTMLElement ? block.dataset.blockId : undefined;
}

function offsetIn(field: HTMLElement, node: Node, offset: number): number {
  const range = field.ownerDocument.createRange();
  range.selectNodeContents(field);
  range.setEnd(node, offset);
  return range.toString().length;
}

export function textRange(root: HTMLElement, range: StaticRange): TextSelection | undefined {
  const field = fieldOf(range.startContainer);
  const blockId = blockOf(field ?? null);
  const name = field?.dataset.field;
  if (field === undefined || blockId === undefined || name === undefined) return undefined;
  if (!root.contains(field) || fieldOf(range.endContainer) !== field) return undefined;
  const from = offsetIn(field, range.startContainer, range.startOffset);
  const to = offsetIn(field, range.endContainer, range.endOffset);
  return { kind: 'text', blockId, field: name, from: Math.min(from, to), to: Math.max(from, to) };
}

export function readSelection(root: HTMLElement): TextSelection | undefined {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0) return undefined;
  return textRange(root, selection.getRangeAt(0));
}

export function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind === 'blocks' || b.kind === 'blocks') {
    const [left, right] = [a.kind === 'blocks' ? a.ids : [], b.kind === 'blocks' ? b.ids : []];
    return (
      a.kind === b.kind && left.length === right.length && left.every((id, i) => right[i] === id)
    );
  }
  return a.blockId === b.blockId && a.field === b.field && a.from === b.from && a.to === b.to;
}

export function fieldElement(root: HTMLElement, blockId: BlockId, name: string) {
  for (const field of root.querySelectorAll<HTMLElement>('[data-field]')) {
    if (field.dataset.field === name && blockOf(field) === blockId) return field;
  }
  return undefined;
}

export function mark(root: HTMLElement, selection: Selection): void {
  const selected = new Set(selection.kind === 'blocks' ? selection.ids : []);
  for (const block of root.querySelectorAll<HTMLElement>('[data-block-id]')) {
    block.toggleAttribute('data-selected', selected.has(block.dataset.blockId ?? ''));
  }
}

function point(field: HTMLElement, offset: number): [Node, number] {
  const text = field.firstChild;
  return text instanceof Text ? [text, Math.min(offset, text.length)] : [field, 0];
}

export function place(root: HTMLElement, selection: Selection): void {
  mark(root, selection);
  const dom = root.ownerDocument.getSelection();
  if (selection.kind === 'blocks') {
    dom?.removeAllRanges();
    root.focus({ preventScroll: true });
    return;
  }
  const field = fieldElement(root, selection.blockId, selection.field);
  // A field not yet mounted gets the caret from bindField, which needs focus kept in root.
  if (field === undefined) {
    root.focus({ preventScroll: true });
    return;
  }
  if (dom === null) return;
  if (root.ownerDocument.activeElement !== field) field.focus({ preventScroll: true });
  dom.setBaseAndExtent(...point(field, selection.from), ...point(field, selection.to));
}

export function offsetAtPoint(field: HTMLElement, x: number, y: number): number | undefined {
  const document = field.ownerDocument;
  const position = document.caretPositionFromPoint?.(x, y);
  if (position && field.contains(position.offsetNode)) {
    return offsetIn(field, position.offsetNode, position.offset);
  }
  const range = document.caretRangeFromPoint?.(x, y);
  if (range && field.contains(range.startContainer)) {
    return offsetIn(field, range.startContainer, range.startOffset);
  }
  return undefined;
}

export function onEdgeLine(field: HTMLElement, direction: -1 | 1): boolean {
  const selection = field.ownerDocument.getSelection();
  const caret = selection?.rangeCount ? selection.getRangeAt(0).getClientRects()[0] : undefined;
  if (caret === undefined || caret.height === 0) return true;
  const box = field.getBoundingClientRect();
  const gap = direction < 0 ? caret.top - box.top : box.bottom - caret.bottom;
  return gap < caret.height / 2;
}
