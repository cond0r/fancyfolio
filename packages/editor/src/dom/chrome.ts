import type { Editor } from '../core/types.ts';

export function flagSelected(block: HTMLElement, editor: Editor): void {
  const selection = editor.store.get(editor.selection);
  const id = block.dataset.blockId;
  block.toggleAttribute(
    'data-selected',
    selection.kind === 'blocks' && id !== undefined && selection.ids.includes(id),
  );
}

export function bindSelection(root: HTMLElement, editor: Editor): () => void {
  const live = root.querySelector(':scope > [data-ff-live]');
  let frame = 0;
  const flag = () => {
    frame = 0;
    const selection = editor.store.get(editor.selection);
    const query = selection.kind === 'blocks' ? '[data-block-id]' : '[data-selected]';
    for (const block of root.querySelectorAll<HTMLElement>(query)) flagSelected(block, editor);
    const count = selection.kind === 'blocks' ? selection.ids.length : 0;
    const text = count === 0 ? '' : `${count} block${count === 1 ? '' : 's'} selected`;
    if (live !== null && live.textContent !== text) live.textContent = text;
  };
  const unsubscribe = editor.store.sub(editor.selection, () => {
    if (frame === 0) frame = requestAnimationFrame(flag);
  });
  return () => {
    unsubscribe();
    cancelAnimationFrame(frame);
  };
}
