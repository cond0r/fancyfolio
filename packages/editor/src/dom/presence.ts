import type { Editor } from '../core/types.ts';
import { blockElement } from './overlay.ts';
import { rangeRect } from './selection.ts';

export function bindPresence(layer: HTMLElement, editor: Editor): () => void {
  const root = layer.closest<HTMLElement>('[data-ff-editor]');
  if (root === null) throw new Error('the presence layer sits outside an editor');
  const document = root.ownerDocument;
  const markers = new Map<string, HTMLElement>();
  let present = new Set<HTMLElement>();
  let frame = 0;

  const markerOf = (userId: string) => {
    const existing = markers.get(userId);
    if (existing !== undefined) return existing;
    const marker = document.createElement('div');
    const label = document.createElement('span');
    marker.setAttribute('data-ff-peer', '');
    label.setAttribute('data-ff-peer-label', '');
    label.textContent = userId;
    marker.append(label);
    layer.append(marker);
    markers.set(userId, marker);
    return marker;
  };

  const paint = () => {
    frame = 0;
    const others = editor.store.get(editor.others);
    const origin = root.getBoundingClientRect();
    const blocks = new Set<HTMLElement>();
    for (const each of others) {
      const marker = markerOf(each.userId);
      const block = blockElement(root, each.blockId);
      const rect = block === undefined ? undefined : rangeRect(root, each);
      marker.hidden = rect === undefined;
      if (block === undefined || rect === undefined) continue;
      blocks.add(block);
      const caret = each.from === each.to;
      marker.toggleAttribute('data-range', !caret);
      marker.style.translate = `${rect.left - origin.left}px ${rect.top - origin.top}px`;
      marker.style.width = caret ? '' : `${rect.width}px`;
      marker.style.height = `${rect.height}px`;
    }
    const ids = new Set(others.map((each) => each.userId));
    for (const [userId, marker] of markers) {
      if (ids.has(userId)) continue;
      marker.remove();
      markers.delete(userId);
    }
    for (const block of present) if (!blocks.has(block)) block.removeAttribute('data-present');
    for (const block of blocks) block.setAttribute('data-present', '');
    present = blocks;
  };

  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(paint);
  };

  const unsubscribe = editor.store.sub(editor.others, schedule);
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  const mutation = new MutationObserver((records) => {
    if (records.some(({ target }) => !layer.contains(target))) schedule();
  });
  mutation.observe(root, { childList: true, characterData: true, subtree: true });
  schedule();
  return () => {
    unsubscribe();
    resize.disconnect();
    mutation.disconnect();
    cancelAnimationFrame(frame);
    for (const marker of markers.values()) marker.remove();
    for (const block of present) block.removeAttribute('data-present');
  };
}
