import { placeOf } from '../core/tree.ts';
import type { Block, BlockId, DocView, Editor } from '../core/types.ts';
import type { Box, Overlay, Targets } from './types.ts';

export const blockElement = (root: HTMLElement, blockId: BlockId) =>
  [...root.querySelectorAll<HTMLElement>('[data-block-id]')].find(
    (block) => block.dataset.blockId === blockId,
  );

export function positionOf(view: DocView, blockId: BlockId, labelOf: (block: Block) => string) {
  const block = view.blocks.get(blockId);
  const at = placeOf(view, blockId);
  if (block === undefined || at === undefined) return undefined;
  const owner = at.parent === null ? undefined : view.blocks.get(at.parent.blockId);
  const where = owner === undefined ? '' : ` in ${labelOf(owner)}`;
  return { label: labelOf(block), position: `${at.index + 1} of ${at.list.length}${where}` };
}

export function bindOverlay(
  overlay: HTMLElement,
  editor: Editor,
  labelOf: (block: Block) => string,
): Overlay & { readonly chrome: HTMLElement; readonly unbind: () => void } {
  const root = overlay.closest<HTMLElement>('[data-ff-editor]');
  const chrome = overlay.querySelector<HTMLElement>(':scope > [data-ff-chrome]');
  const line = overlay.querySelector<HTMLElement>(':scope > [data-ff-drop]');
  if (root === null || chrome === null || line === null) {
    throw new Error('the block overlay sits outside an editor');
  }
  const handle = chrome.querySelector('[data-ff-handle]');
  const insert = chrome.querySelector('[data-ff-insert]');
  const boxes = new Map<BlockId, Box>();
  let targets: Targets = {};
  let frame = 0;

  const outermost = (block: HTMLElement): HTMLElement => {
    const up = block.parentElement?.closest<HTMLElement>('[data-block-id]');
    return up && root.contains(up) ? outermost(up) : block;
  };

  const measure = (blockId: BlockId): Box | undefined => {
    const cached = boxes.get(blockId);
    const block = cached === undefined ? blockElement(root, blockId) : undefined;
    if (block === undefined) return cached;
    const from = root.getBoundingClientRect();
    const box = block.getBoundingClientRect();
    const field = [...block.querySelectorAll('[data-field]')].find(
      (each) => each.closest('[data-block-id]') === block,
    );
    const first = field?.getClientRects()[0];
    const top =
      first === undefined
        ? (block.firstElementChild ?? block).getBoundingClientRect().top
        : first.top + (first.height - chrome.offsetHeight) / 2;
    const measured = {
      left: box.left - from.left,
      top: box.top - from.top,
      width: box.width,
      height: box.height,
      handle: top - from.top,
      column: outermost(block).getBoundingClientRect().left - from.left,
    };
    boxes.set(blockId, measured);
    return measured;
  };

  const paint = () => {
    frame = 0;
    const live = (blockId: BlockId | undefined) =>
      blockId !== undefined && measure(blockId) !== undefined ? blockId : undefined;
    const aim = live(targets.aim?.blockId) === undefined ? undefined : targets.aim;
    targets = {
      hovered: live(targets.hovered),
      selected: live(targets.selected),
      pinned: live(targets.pinned),
      source: live(targets.source),
      aim,
    };
    const target = targets.pinned ?? targets.source ?? targets.hovered ?? targets.selected;
    const box = target === undefined ? undefined : measure(target);
    const drop = aim === undefined ? undefined : measure(aim.blockId);
    const at = target === undefined ? undefined : positionOf(editor.view, target, labelOf);
    if (target === undefined || box === undefined) delete chrome.dataset.ffTarget;
    else {
      chrome.style.translate = `${box.column}px ${box.handle}px`;
      chrome.dataset.ffTarget = target;
    }
    if (at !== undefined) {
      handle?.setAttribute('aria-label', `${at.label} options, ${at.position}`);
      insert?.setAttribute('aria-label', `Insert below ${at.label}, ${at.position}`);
    }
    line.hidden = drop === undefined;
    if (drop === undefined || aim === undefined) return;
    const edge = aim.side === 'before' ? drop.top : drop.top + drop.height;
    line.style.transform = `translate(${drop.left}px, ${edge}px)`;
    line.style.width = `${drop.width}px`;
  };

  const request = () => {
    if (frame === 0) frame = requestAnimationFrame(paint);
  };

  const remeasure = () => {
    boxes.clear();
    request();
  };

  const onGutterPress = (event: PointerEvent) => {
    const block = event.target;
    if (!(block instanceof HTMLElement) || !block.matches('[data-block-id]')) return;
    if (event.clientX >= block.getBoundingClientRect().left) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const controller = new AbortController();
  root.addEventListener('pointerdown', onGutterPress, {
    signal: controller.signal,
    capture: true,
  });
  const resize = new ResizeObserver(remeasure);
  resize.observe(root);
  const mutation = new MutationObserver(remeasure);
  mutation.observe(root, { childList: true, subtree: true });
  return {
    chrome,
    set(patch) {
      targets = { ...targets, ...patch };
      request();
    },
    flush() {
      cancelAnimationFrame(frame);
      paint();
    },
    unbind() {
      controller.abort();
      resize.disconnect();
      mutation.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}
