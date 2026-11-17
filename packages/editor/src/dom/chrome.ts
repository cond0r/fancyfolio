import { placeOf } from '../core/tree.ts';
import type { Block, BlockId, Editor } from '../core/types.ts';
import { editsIn, saveOn } from './field.ts';
import { blockOf, place } from './selection.ts';

const blockElement = (root: HTMLElement, blockId: BlockId) =>
  [...root.querySelectorAll<HTMLElement>('[data-block-id]')].find(
    (block) => block.dataset.blockId === blockId,
  );

function stepTo(items: readonly HTMLElement[], at: number, key: string): number | undefined {
  const last = items.length - 1;
  if (key === 'ArrowDown') return at >= last ? 0 : at + 1;
  if (key === 'ArrowUp') return at <= 0 ? last : at - 1;
  if (key === 'Home' || key === 'End') return key === 'Home' ? 0 : last;
  if (key.length !== 1) return undefined;
  const letter = key.toLowerCase();
  const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
  const found = order.find((item) => item.textContent?.trim().toLowerCase().startsWith(letter));
  return found === undefined ? undefined : items.indexOf(found);
}

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

export function placeMenu(menu: HTMLElement, anchor: DOMRect): void {
  const { clientWidth, clientHeight } = menu.ownerDocument.documentElement;
  const { width, height } = menu.getBoundingClientRect();
  const x = Math.max(0, Math.min(anchor.left, clientWidth - width));
  const y =
    anchor.bottom + height <= clientHeight ? anchor.bottom : Math.max(0, anchor.top - height);
  menu.style.translate = `${x}px ${y}px`;
}

export function choose(item: HTMLElement, run: (root: HTMLElement, blockId: BlockId) => void) {
  const chrome = item.closest<HTMLElement>('[data-ff-chrome]');
  const root = chrome?.closest<HTMLElement>('[data-ff-editor]');
  const blockId = chrome?.dataset.ffTarget;
  if (root === null || root === undefined || blockId === undefined) return;
  item.closest<HTMLElement>('[popover]')?.hidePopover();
  run(root, blockId);
}

export function bindChrome(
  chrome: HTMLElement,
  editor: Editor,
  labelOf: (block: Block) => string,
): () => void {
  const root = chrome.closest<HTMLElement>('[data-ff-editor]');
  if (root === null) throw new Error('the block chrome sits outside an editor');
  const { store, view } = editor;
  const document = root.ownerDocument;
  const handle = chrome.querySelector<HTMLButtonElement>('[data-ff-handle]');
  const menu = chrome.querySelector<HTMLElement>('[data-ff-menu]');
  let hovered: BlockId | undefined;
  let pinned: BlockId | undefined;
  let frame = 0;

  const focused = () => {
    const selection = store.get(editor.selection);
    return selection.kind === 'text' ? selection.blockId : selection.ids[0];
  };

  const nameOf = (blockId: BlockId) => {
    const block = view.blocks.get(blockId);
    const at = placeOf(view, blockId);
    if (block === undefined || at === undefined) return 'Block options';
    const owner = at.parent === null ? undefined : view.blocks.get(at.parent.blockId);
    const where = owner === undefined ? '' : ` in ${labelOf(owner)}`;
    return `${labelOf(block)} options, ${at.index + 1} of ${at.list.length}${where}`;
  };

  const show = () => {
    for (const blockId of pinned === undefined ? [hovered, focused()] : [pinned]) {
      const block = blockId === undefined ? undefined : blockElement(root, blockId);
      if (blockId === undefined || block === undefined) continue;
      const [from, to] = [root.getBoundingClientRect(), block.getBoundingClientRect()];
      chrome.style.translate = `${to.left - from.left}px ${to.top - from.top}px`;
      chrome.dataset.ffTarget = blockId;
      handle?.setAttribute('aria-label', nameOf(blockId));
      return;
    }
    delete chrome.dataset.ffTarget;
  };

  const onPointerOver = (event: PointerEvent) => {
    if (!(event.target instanceof Node) || chrome.contains(event.target)) return;
    const blockId = blockOf(event.target);
    if (blockId === undefined || blockId === hovered) return;
    hovered = blockId;
    show();
  };

  const onPointerLeave = () => {
    hovered = undefined;
    show();
  };

  const controller = new AbortController();
  const options = { signal: controller.signal };
  root.addEventListener('pointerover', onPointerOver, options);
  root.addEventListener('pointerleave', onPointerLeave, options);
  chrome.addEventListener('keydown', (event) => saveOn(event, editor), options);

  if (handle !== null && menu !== null) {
    const focusFirst = () => {
      if (!menu.contains(document.activeElement))
        menu.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    };

    const follow = () => {
      if (menu.matches(':popover-open')) placeMenu(menu, handle.getBoundingClientRect());
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
      if (!mod || event.key !== '/' || !editsIn(root, event.target)) return;
      pinned = focused();
      if (pinned === undefined) return;
      event.preventDefault();
      menu.showPopover();
      focusFirst();
    };

    const onBeforeToggle = (event: ToggleEvent) => {
      if (event.newState !== 'open') return;
      pinned ??= chrome.dataset.ffTarget;
      show();
      requestAnimationFrame(follow);
    };

    const onToggle = (event: ToggleEvent) => {
      if (event.newState === 'open') {
        focusFirst();
        return;
      }
      pinned = undefined;
      show();
      place(root, store.get(editor.selection));
    };

    const onOutsidePress = (event: PointerEvent) => {
      const outside = event.target instanceof Node && !chrome.contains(event.target);
      if (outside && menu.matches(':popover-open')) event.preventDefault();
    };

    const onMenuKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
      const at = items.findIndex((item) => item === document.activeElement);
      const to = event.key === 'Tab' ? -1 : stepTo(items, at, event.key);
      if (to === undefined) return;
      event.preventDefault();
      if (to === -1) menu.hidePopover();
      else items[to]?.focus();
    };

    root.addEventListener('keydown', onKeyDown, options);
    menu.addEventListener('beforetoggle', onBeforeToggle, options);
    menu.addEventListener('toggle', onToggle, options);
    menu.addEventListener('keydown', onMenuKeyDown, options);
    document.addEventListener('pointerdown', onOutsidePress, { ...options, capture: true });
    document.addEventListener('scroll', follow, { ...options, capture: true, passive: true });
    document.defaultView?.addEventListener('resize', follow, options);
  }

  const unsubscribe = store.sub(editor.selection, () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(show);
  });
  const resize = new ResizeObserver(show);
  resize.observe(root);
  show();
  return () => {
    controller.abort();
    unsubscribe();
    resize.disconnect();
    cancelAnimationFrame(frame);
  };
}
