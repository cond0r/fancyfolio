import { coverage, isMarkType, marksIn } from '../core/marks.ts';
import type { BlockId, Case, Editor, Mark, MarkType, TextSelection } from '../core/types.ts';
import { placeMenu } from './chrome.ts';
import { fieldElement, fieldOf, place, readSelection, sameSelection } from './selection.ts';
import type { Shown } from './types.ts';

const gap = 8;
const refused = 'Only https:// and mailto: links';
const cases: readonly Case[] = ['upper', 'lower', 'capitalize'];

function stepTo(count: number, at: number, key: string, back: string, forth: string) {
  if (key === back) return (at - 1 + count) % count;
  if (key === forth) return (at + 1) % count;
  if (key === 'Home' || key === 'End') return key === 'Home' ? 0 : count - 1;
  return undefined;
}

function covers(marks: readonly Mark[], type: MarkType, { from, to }: TextSelection): boolean {
  const spans = coverage(marks, type, from, to);
  return spans.reduce((sum, span) => sum + span.to - span.from, 0) === to - from;
}

function must<E extends Element>(element: E | null): E {
  if (element === null) throw new Error('the toolbar misses a control');
  return element;
}

export function bindToolbar(bar: HTMLElement, editor: Editor): () => void {
  const root = bar.closest<HTMLElement>('[data-ff-editor]');
  if (root === null) throw new Error('the toolbar sits outside an editor');
  const { store } = editor;
  const document = root.ownerDocument;
  const tools = [...bar.querySelectorAll<HTMLButtonElement>('[data-ff-tools] > button')];
  const toggles = tools.flatMap((button) => {
    const mark = button.dataset.ffMark;
    return mark !== undefined && isMarkType(mark) ? [{ button, mark }] : [];
  });
  const menu = must(bar.querySelector<HTMLElement>('[role="menu"]'));
  const opener = must(bar.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]'));
  const linker = must(bar.querySelector<HTMLButtonElement>('[data-ff-linker]'));
  const form = must(bar.querySelector('form'));
  const input = must(form.querySelector('input'));
  const unlink = must(form.querySelector<HTMLButtonElement>('[data-ff-unlink]'));
  const error = must(bar.querySelector('[data-ff-error]'));
  const coarse = document.defaultView?.matchMedia('(pointer: coarse)');
  let down = false;
  let composing = false;
  let frame = 0;
  let roving = 0;
  let watched: { readonly blockId: BlockId; readonly stop: () => void } | undefined;
  let linking: { readonly at: TextSelection; readonly range: Range } | undefined;

  const shownAt = (at: TextSelection): Shown | undefined => {
    const atom = editor.blocks.get(at.blockId);
    return atom === undefined ? undefined : { at, marks: marksIn(store.get(atom), at.field) };
  };

  const active = (): Shown | 'behind' | undefined => {
    const at = store.get(editor.selection);
    if (down || composing || at.kind !== 'text') return undefined;
    if (linking !== undefined) {
      const kept = sameSelection(linking.at, at) && bar.contains(document.activeElement);
      return kept ? shownAt(at) : undefined;
    }
    const dom = readSelection(root);
    if (dom === undefined || dom.from === dom.to) return undefined;
    // The DOM selection runs ahead of the store until selectionchange, which schedules again.
    if (!sameSelection(dom, at)) return 'behind';
    const field = fieldElement(root, at.blockId, at.field);
    const focus = document.activeElement;
    if (field === undefined || (focus !== field && !bar.contains(focus))) return undefined;
    if (!toggles.some(({ mark }) => editor.can('toggleMark', { mark }))) return undefined;
    return shownAt(at);
  };

  const closeForm = () => {
    linking = undefined;
    form.hidden = true;
    input.removeAttribute('aria-invalid');
    error.textContent = '';
  };

  const hide = () => {
    bar.hidden = true;
    closeForm();
    if (menu.matches(':popover-open')) menu.hidePopover();
  };

  const placeBar = (range: DOMRect) => {
    const { clientWidth, clientHeight } = document.documentElement;
    const { width, height } = bar.getBoundingClientRect();
    const x = Math.max(0, Math.min(range.left + (range.width - width) / 2, clientWidth - width));
    const above = range.top - gap - height;
    const below = coarse?.matches === true || above < 0;
    const y = below ? Math.max(0, Math.min(range.bottom + gap, clientHeight - height)) : above;
    bar.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
  };

  const draw = () => {
    frame = 0;
    const shown = active();
    if (shown === 'behind') return;
    if (shown === undefined) return hide();
    const range = (
      linking?.range ?? document.getSelection()?.getRangeAt(0)
    )?.getBoundingClientRect();
    if (range === undefined) return hide();
    for (const { button, mark } of toggles) {
      button.setAttribute('aria-pressed', String(covers(shown.marks, mark, shown.at)));
      button.setAttribute('aria-disabled', String(!editor.can('toggleMark', { mark })));
    }
    linker.setAttribute('aria-pressed', String(covers(shown.marks, 'link', shown.at)));
    bar.hidden = false;
    if (!bar.matches(':popover-open')) bar.showPopover();
    placeBar(range);
    if (menu.matches(':popover-open')) placeMenu(menu, opener.getBoundingClientRect());
  };

  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(draw);
  };

  const watch = () => {
    const at = store.get(editor.selection);
    const blockId = at.kind === 'text' ? at.blockId : undefined;
    if (watched?.blockId === blockId) return;
    watched?.stop();
    const atom = blockId === undefined ? undefined : editor.blocks.get(blockId);
    watched =
      blockId === undefined || atom === undefined
        ? undefined
        : { blockId, stop: store.sub(atom, schedule) };
  };

  const back = () => {
    hide();
    place(root, store.get(editor.selection));
    schedule();
  };

  const openForm = () => {
    const shown = active();
    if (shown === undefined || shown === 'behind') return;
    const range = document.getSelection()?.getRangeAt(0);
    if (range === undefined) return;
    const links = coverage(shown.marks, 'link', shown.at.from, shown.at.to);
    linking = { at: shown.at, range: range.cloneRange() };
    input.value = links[0]?.href ?? '';
    unlink.hidden = links.length === 0;
    form.hidden = false;
    input.focus({ preventScroll: true });
    schedule();
  };

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    const shown = active();
    if (shown === undefined || shown === 'behind') return;
    const href = input.value;
    const links = coverage(shown.marks, 'link', shown.at.from, shown.at.to);
    const kept = covers(shown.marks, 'link', shown.at) && links.every((link) => link.href === href);
    if (kept || editor.command('setLink', { href })) return back();
    input.setAttribute('aria-invalid', 'true');
    error.textContent = refused;
  };

  const act = (run: () => boolean) => {
    const focus = document.activeElement;
    run();
    place(root, store.get(editor.selection));
    if (focus instanceof HTMLElement && bar.contains(focus)) {
      (menu.contains(focus) ? opener : focus).focus();
    }
  };

  const focusTool = (to: number) => {
    roving = to;
    for (const [index, each] of tools.entries()) each.tabIndex = index === to ? 0 : -1;
    tools[to]?.focus();
  };

  const onRootKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (!(event.target instanceof Node) || fieldOf(event.target) === undefined) return;
    const mod = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
    const link = mod && event.key.toLowerCase() === 'k';
    if ((!link && (!event.altKey || event.key !== 'F10')) || bar.hidden) return;
    event.preventDefault();
    if (link) openForm();
    else focusTool(roving);
  };

  const onBarKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const focus = document.activeElement;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (event.key === 'Escape') {
      if (menu.contains(focus)) {
        menu.hidePopover();
        opener.focus();
      } else back();
    } else if (focus instanceof HTMLElement && menu.contains(focus)) {
      const to = stepTo(items.length, items.indexOf(focus), event.key, 'ArrowUp', 'ArrowDown');
      if (to === undefined) return;
      items[to]?.focus();
    } else if (focus instanceof HTMLButtonElement && tools.includes(focus)) {
      const to = stepTo(tools.length, tools.indexOf(focus), event.key, 'ArrowLeft', 'ArrowRight');
      if (to === undefined) return;
      focusTool(to);
    } else return;
    event.preventDefault();
  };

  const onClick = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (button === null || button.getAttribute('aria-disabled') === 'true') return;
    if (button === linker) return openForm();
    if (button === unlink) {
      editor.command('setLink', { href: null });
      return back();
    }
    const mark = button.dataset.ffMark;
    const to = cases.find((each) => each === button.dataset.ffCase);
    if (mark !== undefined && isMarkType(mark)) act(() => editor.command('toggleMark', { mark }));
    if (to === undefined) return;
    menu.hidePopover();
    act(() => editor.command('setCase', { to }));
  };

  const onMenuToggle = (event: ToggleEvent) => {
    if (event.newState !== 'open') return;
    placeMenu(menu, opener.getBoundingClientRect());
    if (document.activeElement === opener)
      menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || (event.target instanceof Node && bar.contains(event.target))) return;
    down = true;
    schedule();
  };

  const onPointerUp = () => {
    if (!down) return;
    down = false;
    schedule();
  };

  const onComposition = (event: CompositionEvent) => {
    composing = event.type === 'compositionstart';
    schedule();
  };

  const controller = new AbortController();
  const options = { signal: controller.signal };
  root.addEventListener('keydown', onRootKeyDown, options);
  root.addEventListener('pointerdown', onPointerDown, options);
  root.addEventListener('compositionstart', onComposition, options);
  root.addEventListener('compositionend', onComposition, options);
  root.addEventListener('focusin', schedule, options);
  root.addEventListener('focusout', schedule, options);
  bar.addEventListener(
    'pointerdown',
    (event) => {
      if (event.target !== input) event.preventDefault();
    },
    options,
  );
  bar.addEventListener('keydown', onBarKeyDown, options);
  bar.addEventListener('click', onClick, options);
  form.addEventListener('submit', onSubmit, options);
  menu.addEventListener('toggle', onMenuToggle, options);
  document.addEventListener('selectionchange', schedule, options);
  document.addEventListener('pointerup', onPointerUp, options);
  document.addEventListener('pointercancel', onPointerUp, options);
  document.addEventListener('scroll', schedule, { ...options, capture: true, passive: true });
  document.defaultView?.addEventListener('resize', schedule, options);
  watch();
  const unsubscribe = store.sub(editor.selection, () => {
    watch();
    schedule();
  });
  return () => {
    controller.abort();
    unsubscribe();
    watched?.stop();
    cancelAnimationFrame(frame);
    hide();
  };
}
