import { pathOf } from '../core/tree.ts';
import type { Block, BlockId, Editor } from '../core/types.ts';
import { blockElement, positionOf } from './overlay.ts';
import { place } from './selection.ts';
import type { Drop, Overlay, Press } from './types.ts';

const travel = 5;
const hold = 150;
const slide = { duration: 180, easing: 'ease-out' };
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
  const handle = chrome.querySelector<HTMLElement>('[data-ff-handle]');
  if (root === null || handle === null) return () => {};
  const { store, view } = editor;
  const document = root.ownerDocument;
  const live = root.querySelector(':scope > [data-ff-live]');
  let press: Press | undefined;
  let dragged = false;
  let frame = 0;

  const offsetOf = (box: DOMRect) => {
    const from = root.getBoundingClientRect();
    return { x: box.left - from.left, y: box.top - from.top };
  };

  const ghostOf = (block: HTMLElement) => {
    const ghost = block.cloneNode(true) as HTMLElement;
    for (const node of [ghost, ...ghost.querySelectorAll('*')]) {
      for (const name of unique) node.removeAttribute(name);
    }
    const box = block.getBoundingClientRect();
    const at = offsetOf(box);
    ghost.setAttribute('data-ff-ghost', '');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, {
      left: `${at.x}px`,
      top: `${at.y}px`,
      width: `${box.width}px`,
      margin: '0',
    });
    root.append(ghost);
    return ghost;
  };

  const targetAt = (hit: Element, blockId: BlockId) => {
    let block: HTMLElement | null | undefined = hit.closest<HTMLElement>('[data-block-id]');
    while (block) {
      const id = block.dataset.blockId;
      if (id !== undefined && pathOf(view, id)?.includes(blockId) === false) return { id, block };
      block = block.parentElement?.closest<HTMLElement>('[data-block-id]');
    }
    return undefined;
  };

  const aim = (current: Press, x: number, y: number) => {
    const hit = document.elementFromPoint(x, y);
    const inside = hit !== null && root.contains(hit);
    const target = inside ? targetAt(hit, current.blockId) : undefined;
    if (inside && target === undefined) return;
    const box = target?.block.getBoundingClientRect();
    const side = box !== undefined && y >= box.top + box.height / 2 ? 'after' : 'before';
    const key = target === undefined ? undefined : `${target.id} ${side}`;
    if (key === current.aim) return;
    current.aim = key;
    const drop: Drop | undefined =
      target === undefined ? undefined : { blockId: current.blockId, target: target.id, side };
    current.drop = drop !== undefined && editor.can('moveBlockTo', drop) ? drop : undefined;
    overlay.set({ aim: current.drop && { blockId: current.drop.target, side } });
  };

  const end = () => {
    const current = press;
    if (current === undefined) return undefined;
    press = undefined;
    overlay.set({ source: undefined, aim: undefined });
    current.block?.removeAttribute('data-dragging');
    const from = current.ghost?.getBoundingClientRect();
    current.ghost?.remove();
    dragged = current.started;
    return { drop: current.drop, from };
  };

  const settle = (blockId: BlockId, from: DOMRect | undefined) => {
    const block = blockElement(root, blockId);
    const still = document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (block === undefined || from === undefined || still !== false) return;
    const to = block.getBoundingClientRect();
    const shift = `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
    block.animate([{ transform: shift }, { transform: 'none' }], slide);
  };

  const onPointerDown = (event: PointerEvent) => {
    const blockId = chrome.dataset.ffTarget;
    if (event.button !== 0 || blockId === undefined || press !== undefined) return;
    dragged = false;
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
    const { drop, from } = end() ?? {};
    if (drop === undefined || !editor.command('moveBlockTo', drop)) return;
    place(root, store.get(editor.selection));
    const at = positionOf(view, drop.blockId, labelOf);
    const text = at === undefined ? '' : `Moved ${at.label} to ${at.position}`;
    cancelAnimationFrame(frame);
    // bindSelection rewrites the live region in the frame after a selection change.
    frame = requestAnimationFrame(() => {
      if (live !== null) live.textContent = text;
      settle(drop.blockId, from);
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || press === undefined) return;
    event.preventDefault();
    end();
  };

  const onClick = (event: MouseEvent) => {
    if (!dragged) return;
    dragged = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const controller = new AbortController();
  const options = { signal: controller.signal };
  handle.addEventListener('pointerdown', onPointerDown, options);
  handle.addEventListener('pointermove', onPointerMove, options);
  handle.addEventListener('pointerup', onPointerUp, options);
  handle.addEventListener('pointercancel', end, options);
  handle.addEventListener('lostpointercapture', end, options);
  handle.addEventListener('click', onClick, { ...options, capture: true });
  document.addEventListener('keydown', onKeyDown, { ...options, capture: true });
  return () => {
    controller.abort();
    cancelAnimationFrame(frame);
    end();
  };
}
