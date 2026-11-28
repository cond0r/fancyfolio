import type { BlockId, Editor } from '../core/types.ts';
import { editsIn, saveOn } from './field.ts';
import { blockOf, place } from './selection.ts';
import type { Overlay } from './types.ts';

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
  // Offset sizes ignore the scale a menu opens from.
  const { offsetWidth: width, offsetHeight: height } = menu;
  const x = Math.max(0, Math.min(anchor.left, clientWidth - width));
  const y =
    anchor.bottom + height <= clientHeight ? anchor.bottom : Math.max(0, anchor.top - height);
  menu.style.translate = `${x}px ${y}px`;
}

export function choose(item: HTMLElement, run: (root: HTMLElement, blockId: BlockId) => void) {
  if (item.getAttribute('aria-disabled') === 'true') return;
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
  overlay: Overlay,
  refresh: (menu: HTMLElement, blockId: BlockId) => void,
): () => void {
  const root = chrome.closest<HTMLElement>('[data-ff-editor]');
  if (root === null) throw new Error('the block chrome sits outside an editor');
  const { store } = editor;
  const document = root.ownerDocument;
  const handle = chrome.querySelector<HTMLButtonElement>('[data-ff-handle]');
  const menus = [...chrome.querySelectorAll<HTMLButtonElement>('button[popovertarget]')].flatMap(
    (invoker) => {
      const menu = invoker.popoverTargetElement;
      return menu instanceof HTMLElement && menu.matches('[data-ff-menu]')
        ? [{ invoker, menu }]
        : [];
    },
  );
  let pinned: BlockId | undefined;

  const focused = () => {
    const selection = store.get(editor.selection);
    return selection.kind === 'text' ? selection.blockId : selection.ids[0];
  };

  const pin = (blockId: BlockId | undefined) => {
    pinned = blockId;
    overlay.set({ pinned });
    if (pinned !== undefined) overlay.flush();
  };

  const onPointer = (event: PointerEvent) => {
    if (!(event.target instanceof Node)) return;
    const hovered = chrome.contains(event.target) ? chrome.dataset.ffTarget : blockOf(event.target);
    overlay.hover(hovered, event.clientX, event.clientY);
  };

  const onPointerLeave = () => overlay.set({ hovered: undefined, selected: undefined });

  const controller = new AbortController();
  const options = { signal: controller.signal };
  root.addEventListener('pointerover', onPointer, options);
  root.addEventListener('pointermove', onPointer, options);
  root.addEventListener('pointerleave', onPointerLeave, options);
  chrome.addEventListener('keydown', (event) => saveOn(event, editor), options);

  const shown = () => menus.find(({ menu }) => menu.matches(':popover-open'));

  const follow = () => {
    const open = shown();
    if (open !== undefined) placeMenu(open.menu, open.invoker.getBoundingClientRect());
  };

  const focusFirst = (menu: HTMLElement) => {
    if (!menu.contains(document.activeElement))
      menu.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
    if (!mod || event.key !== '/' || !editsIn(root, event.target)) return;
    const menu = handle?.popoverTargetElement;
    if (!(menu instanceof HTMLElement)) return;
    const blockId = focused();
    if (blockId === undefined) return;
    pin(blockId);
    event.preventDefault();
    menu.showPopover();
    focusFirst(menu);
  };

  const onOutsidePress = (event: PointerEvent) => {
    const outside = event.target instanceof Node && !chrome.contains(event.target);
    if (outside && shown() !== undefined) event.preventDefault();
  };

  root.addEventListener('keydown', onKeyDown, options);
  document.addEventListener('pointerdown', onOutsidePress, { ...options, capture: true });
  document.addEventListener('scroll', follow, { ...options, capture: true, passive: true });
  document.defaultView?.addEventListener('resize', follow, options);

  for (const { menu } of menus) {
    const onBeforeToggle = (event: ToggleEvent) => {
      if (event.newState !== 'open') return;
      pin(pinned ?? chrome.dataset.ffTarget);
      if (pinned !== undefined) refresh(menu, pinned);
      requestAnimationFrame(follow);
    };

    const onToggle = (event: ToggleEvent) => {
      if (event.newState === 'open') {
        focusFirst(menu);
        return;
      }
      if (shown() !== undefined) return;
      pin(undefined);
      place(root, store.get(editor.selection));
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

    menu.addEventListener('beforetoggle', onBeforeToggle, options);
    menu.addEventListener('toggle', onToggle, options);
    menu.addEventListener('keydown', onMenuKeyDown, options);
  }

  const unsubscribe = store.sub(editor.selection, () => {
    if (!editor.receiving && root.contains(document.activeElement)) {
      overlay.set({ selected: focused() });
    }
  });
  return () => {
    controller.abort();
    unsubscribe();
  };
}
