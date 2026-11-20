import { placeOf } from '../core/tree.ts';
import type { Block, BlockId, DocView, Editor } from '../core/types.ts';
import type { Box, Overlay, Point, Targets } from './types.ts';

const side = (p: Point, a: Point, b: Point) =>
  (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

function inTriangle(p: Point, a: Point, b: Point, c: Point) {
  const turns = [side(p, a, b), side(p, b, c), side(p, c, a)];
  return turns.every((turn) => turn >= 0) || turns.every((turn) => turn <= 0);
}

function distance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const along = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1);
  const t = Math.max(0, Math.min(1, along));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

// Firefox and WebKit report whole-pixel pointers: a far apex's thin triangle needs slack.
const slackPx = 2;

const gap = (p: Point, rect: DOMRect) =>
  Math.hypot(
    Math.max(rect.left - p.x, 0, p.x - rect.right),
    Math.max(rect.top - p.y, 0, p.y - rect.bottom),
  );

function heading(rect: DOMRect, from: Point, to: Point) {
  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];
  return (
    from.x > rect.right &&
    gap(to, rect) < gap(from, rect) &&
    corners.some(
      (corner, index) =>
        inTriangle(to, from, corner, corners.at(index - 1) ?? corner) ||
        distance(to, from, corner) <= slackPx,
    )
  );
}

const restMs = 80;

export const blockElement = (root: HTMLElement, blockId: BlockId) =>
  [...root.querySelectorAll<HTMLElement>('[data-block-id]')].find(
    (block) => block.dataset.blockId === blockId,
  );

function boxTop(view: Element) {
  const style = getComputedStyle(view);
  const edges = [
    style.borderTopWidth,
    style.borderRightWidth,
    style.borderBottomWidth,
    style.borderLeftWidth,
  ];
  const boxed =
    edges.some((edge) => Number.parseFloat(edge) > 0) ||
    style.backgroundColor !== 'rgba(0, 0, 0, 0)';
  return boxed ? view.getBoundingClientRect().top + Number.parseFloat(style.paddingTop) : undefined;
}

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
  let held: BlockId | undefined;
  let apex: Point | undefined;
  let pointer: Point | undefined;
  let rest: ReturnType<typeof setTimeout> | undefined;
  let rested = false;

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
    const view = block.firstElementChild ?? block;
    const top =
      first === undefined
        ? view.getBoundingClientRect().top
        : (boxTop(view) ?? first.top + (first.height - chrome.offsetHeight) / 2);
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

  const towardChrome = () => {
    if (apex === undefined || pointer === undefined || chrome.dataset.ffTarget !== held) {
      return false;
    }
    return heading(chrome.getBoundingClientRect(), apex, pointer);
  };

  const intent = () => {
    const { hovered } = targets;
    clearTimeout(rest);
    const moving = hovered !== undefined && held !== undefined && hovered !== held;
    if (moving && !rested && towardChrome()) {
      rest = setTimeout(() => {
        rested = true;
        request();
      }, restMs);
      return held;
    }
    rested = false;
    held = hovered;
    apex = pointer;
    return held;
  };

  const paint = () => {
    frame = 0;
    const live = (blockId: BlockId | undefined) =>
      blockId !== undefined && measure(blockId) !== undefined ? blockId : undefined;
    const aim = live(targets.aim?.blockId) === undefined ? undefined : targets.aim;
    held = live(held);
    targets = {
      hovered: live(targets.hovered),
      selected: live(targets.selected),
      pinned: live(targets.pinned),
      source: live(targets.source),
      aim,
    };
    const target = targets.pinned ?? targets.source ?? intent() ?? targets.selected;
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
    hover(blockId, x, y) {
      pointer = { x, y };
      if (blockId !== undefined) targets = { ...targets, hovered: blockId };
      if (targets.hovered === held) {
        clearTimeout(rest);
        apex = pointer;
      } else request();
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
      clearTimeout(rest);
    },
  };
}
