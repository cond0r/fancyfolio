import { pathOf } from '../core/tree.ts';
import type { Block, BlockId, Editor } from '../core/types.ts';
import { blockElement, positionOf } from './overlay.ts';
import { place } from './selection.ts';
import type { Drop, Overlay, Press } from './types.ts';

const travel = 5;
const hold = 150;
const unique = [
  'id',
  'data-block-id',
  'data-field',
  'data-selected',
  'contenteditable',
  'tabindex',
];

export function bindDrag(
  chrome: HTMLElement,
  editor: Editor,
  labelOf: (block: Block) => string,
  overlay: Overlay,
): () => void {
  const root = chrome.closest<HTMLElement>('[data-ff-editor]');
  const layer = chrome.closest<HTMLElement>('[data-ff-overlay]');
  const handle = chrome.querySelector<HTMLElement>('[data-ff-grip]');
  if (root === null || layer === null || handle === null) return () => {};
  const { store, view } = editor;
  const document = root.ownerDocument;
  const live = root.querySelector(':scope > [data-ff-live]');
  let press: Press | undefined;
  let frame = 0;

  const copyOf = (block: HTMLElement) => {
    const copy = block.cloneNode(true) as HTMLElement;
    const sources = [block, ...block.querySelectorAll<HTMLElement | SVGElement>('*')];
    const copies = [copy, ...copy.querySelectorAll<HTMLElement | SVGElement>('*')];
    sources.forEach((source, index) => {
      const node = copies[index];
      if (node === undefined) return;
      const style = getComputedStyle(source);
      for (const name of style) node.style.setProperty(name, style.getPropertyValue(name));
      for (const name of unique) node.removeAttribute(name);
    });
    copy.style.margin = '0';
    return copy;
  };

  const backdropOf = (block: HTMLElement) => {
    for (let node = block.parentElement; node !== null; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
    }
    return '';
  };

  const ghostOf = (block: HTMLElement) => {
    const ghost = document.createElement('div');
    const box = block.getBoundingClientRect();
    ghost.setAttribute('data-ff-ghost', '');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      backgroundColor: backdropOf(block),
    });
    ghost.append(copyOf(block));
    layer.append(ghost);
    return ghost;
  };

  const nearest = (owner: HTMLElement, blockId: BlockId, y: number) => {
    let found: { id: BlockId; block: HTMLElement } | undefined;
    let gap = Number.POSITIVE_INFINITY;
    for (const block of owner.querySelectorAll<HTMLElement>('[data-block-id]')) {
      const id = block.dataset.blockId;
      const parent = block.parentElement?.closest('[data-block-id]') ?? root;
      if (id === undefined || id === blockId || parent !== owner) continue;
      const box = block.getBoundingClientRect();
      const distance = Math.max(box.top - y, y - box.bottom, 0);
      if (distance < gap) [found, gap] = [{ id, block }, distance];
    }
    return found;
  };

  const targetAt = (hit: Element, blockId: BlockId, y: number) => {
    const own = hit.closest<HTMLElement>('[data-block-id]');
    if (own === null) return hit === root ? nearest(root, blockId, y) : undefined;
    let block: HTMLElement | null | undefined = own;
    while (block) {
      const id = block.dataset.blockId;
      if (id !== undefined && pathOf(view, id)?.includes(blockId) === false) {
        const inPadding = block === own && hit !== own;
        return (inPadding ? nearest(own, blockId, y) : undefined) ?? { id, block };
      }
      block = block.parentElement?.closest<HTMLElement>('[data-block-id]');
    }
    return undefined;
  };

  const aim = (current: Press, x: number, y: number) => {
    const hit = document.elementsFromPoint(x, y).find((each) => !layer.contains(each));
    const target = hit && root.contains(hit) ? targetAt(hit, current.blockId, y) : undefined;
    if (target === undefined) return;
    const box = target.block.getBoundingClientRect();
    const side = y >= box.top + box.height / 2 ? 'after' : 'before';
    const key = `${target.id} ${side}`;
    if (key === current.aim) return;
    current.aim = key;
    const drop: Drop = { blockId: current.blockId, target: target.id, side };
    current.drop = editor.can('moveBlockTo', drop) ? drop : undefined;
    overlay.set({ aim: current.drop && { blockId: current.drop.target, side } });
  };

  const end = () => {
    const current = press;
    if (current === undefined) return undefined;
    press = undefined;
    overlay.set({ source: undefined, aim: undefined });
    current.block?.removeAttribute('data-dragging');
    current.ghost?.remove();
    return current.drop;
  };

  const onPointerDown = (event: PointerEvent) => {
    const blockId = chrome.dataset.ffTarget;
    if (event.button !== 0 || blockId === undefined || press !== undefined) return;
    handle.setPointerCapture(event.pointerId);
    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: event.timeStamp,
      touch: event.pointerType === 'touch',
      blockId,
      started: false,
      block: undefined,
      ghost: undefined,
      aim: undefined,
      drop: undefined,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    const current = press;
    if (current === undefined || event.pointerId !== current.pointerId) return;
    if (!current.started) {
      const held = !current.touch || event.timeStamp - current.at >= hold;
      const moved = Math.hypot(event.clientX - current.x, event.clientY - current.y);
      if (!held || moved < travel) return;
      current.started = true;
      current.block = blockElement(root, current.blockId);
      current.ghost = current.block && ghostOf(current.block);
      current.block?.setAttribute('data-dragging', '');
      overlay.set({ source: current.blockId });
    }
    const ghost = current.ghost?.style;
    if (ghost)
      ghost.transform = `translate(${event.clientX - current.x}px, ${event.clientY - current.y}px)`;
    aim(current, event.clientX, event.clientY);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (press?.pointerId !== event.pointerId) return;
    const drop = end();
    if (drop === undefined || !editor.command('moveBlockTo', drop)) return;
    place(root, store.get(editor.selection));
    const at = positionOf(view, drop.blockId, labelOf);
    const text = at === undefined ? '' : `Moved ${at.label} to ${at.position}`;
    cancelAnimationFrame(frame);
    // bindSelection rewrites the live region in the frame after a selection change.
    frame = requestAnimationFrame(() => {
      if (live !== null) live.textContent = text;
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || press === undefined) return;
    event.preventDefault();
    end();
  };

  const controller = new AbortController();
  const options = { signal: controller.signal };
  handle.addEventListener('pointerdown', onPointerDown, options);
  handle.addEventListener('pointermove', onPointerMove, options);
  handle.addEventListener('pointerup', onPointerUp, options);
  handle.addEventListener('pointercancel', end, options);
  handle.addEventListener('lostpointercapture', end, options);
  document.addEventListener('keydown', onKeyDown, { ...options, capture: true });
  return () => {
    controller.abort();
    cancelAnimationFrame(frame);
    end();
  };
}
