import { memo, useCallback, useId, useMemo } from 'react';
import type { BlockId, Editor } from '../core/types.ts';
import { placeMenu } from '../dom/chrome.ts';
import { fieldElement, place } from '../dom/selection.ts';
import { entry } from './chrome.tsx';
import { Icon, iconOf } from './icons.tsx';
import type { ChromeProps, Entry, Open } from './types.ts';

const typed = /^\/(\S*)$/;

const matches = (label: string, query: string) =>
  label
    .toLowerCase()
    .split(/\s+/)
    .some((word) => word.startsWith(query.toLowerCase()));

function bindSlash(list: HTMLElement, editor: Editor, choices: readonly Entry[]): () => void {
  const root = list.closest<HTMLElement>('[data-ff-editor]');
  const announce = root?.querySelector(':scope > [data-ff-announce]');
  if (root === null || root === undefined || announce === null || announce === undefined) {
    throw new Error('the / list sits outside an editor');
  }
  const { store } = editor;
  const document = root.ownerDocument;
  const items = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
  let open: Open | undefined;
  let dismissed: { readonly blockId: BlockId; readonly text: string } | undefined;
  let composing = false;

  const typedAt = () => {
    const selection = store.get(editor.selection);
    if (selection.kind !== 'text' || selection.from !== selection.to) return undefined;
    const block = editor.view.blocks.get(selection.blockId);
    const text = block?.fields[selection.field];
    const query = text?.match(typed)?.[1];
    if (block?.type !== 'paragraph' || text === undefined || query === undefined) return undefined;
    if (selection.to !== text.length) return undefined;
    const field = fieldElement(root, block.id, selection.field);
    if (field === undefined || document.activeElement !== field) return undefined;
    return { blockId: block.id, field, text, query };
  };

  const close = () => {
    if (open === undefined) return;
    const { field } = open;
    open = undefined;
    field.setAttribute('role', 'textbox');
    for (const name of ['aria-expanded', 'aria-controls', 'aria-activedescendant']) {
      field.removeAttribute(name);
    }
    if (list.matches(':popover-open')) list.hidePopover();
    announce.textContent = '';
  };

  const activate = (at: Open, index: number) => {
    at.active = index;
    for (const [i, item] of items.entries()) {
      item.setAttribute('aria-selected', String(i === index));
    }
    at.field.setAttribute('aria-activedescendant', items[index]?.id ?? '');
    const label = choices[index]?.label ?? '';
    if (announce.textContent !== label) announce.textContent = label;
  };

  const update = () => {
    const at = typedAt();
    if (at === undefined) return close();
    if (dismissed?.blockId === at.blockId && dismissed.text === at.text) return close();
    dismissed = undefined;
    if (open !== undefined && (open.blockId !== at.blockId || open.field !== at.field)) close();
    const current: Open = open ?? {
      blockId: at.blockId,
      field: at.field,
      allowed: choices.flatMap((choice, index) => (choice.can(at.blockId) ? [index] : [])),
      text: at.text,
      shown: [],
      active: -1,
    };
    const shown = current.allowed.filter((index) => matches(choices[index]?.label ?? '', at.query));
    const [first] = shown;
    if (first === undefined) return close();
    for (const [index, item] of items.entries()) item.hidden = !shown.includes(index);
    if (!list.matches(':popover-open')) list.showPopover();
    open = current;
    current.text = at.text;
    current.shown = shown;
    at.field.setAttribute('role', 'combobox');
    at.field.setAttribute('aria-expanded', 'true');
    at.field.setAttribute('aria-controls', list.id);
    activate(current, shown.includes(current.active) ? current.active : first);
    placeMenu(list, at.field.getBoundingClientRect());
  };

  const pick = (index: number) => {
    const at = open;
    const choice = choices[index];
    if (at === undefined || choice === undefined) return;
    close();
    choice.run(root, at.blockId);
    // A new block type remounts the field after this task's render, dropping its focus.
    queueMicrotask(() => {
      if (!at.field.isConnected) place(root, store.get(editor.selection));
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (open === undefined || event.target !== open.field || event.isComposing || composing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const { shown, active } = open;
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step !== 0) {
      const at = shown.indexOf(active) + step;
      activate(open, shown[(at + shown.length) % shown.length] ?? active);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      pick(active);
    } else if (event.key === 'Escape') {
      dismissed = { blockId: open.blockId, text: open.text };
      close();
    } else {
      return;
    }
    event.preventDefault();
  };

  const onClick = (event: MouseEvent) => {
    const option = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
    const index = option instanceof HTMLElement ? items.indexOf(option) : -1;
    if (index >= 0) pick(index);
  };

  const follow = () => {
    if (open !== undefined) placeMenu(list, open.field.getBoundingClientRect());
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      update();
    });
  };

  const controller = new AbortController();
  const options = { signal: controller.signal };
  // Focus can land here while a popover is still hiding, where showPopover throws.
  const afterFocus = () =>
    setTimeout(() => {
      if (!controller.signal.aborted) schedule();
    });
  root.addEventListener('keydown', onKeyDown, { ...options, capture: true });
  const composition = (event: CompositionEvent) => {
    composing = event.type === 'compositionstart';
  };
  root.addEventListener('compositionstart', composition, options);
  root.addEventListener('compositionend', composition, options);
  root.addEventListener('focusin', afterFocus, options);
  root.addEventListener('focusout', afterFocus, options);
  list.addEventListener('pointerdown', (event) => event.preventDefault(), options);
  list.addEventListener('click', onClick, options);
  document.addEventListener('scroll', follow, { ...options, capture: true, passive: true });
  document.defaultView?.addEventListener('resize', follow, options);
  const unsubscribe = store.sub(editor.selection, schedule);
  return () => {
    controller.abort();
    unsubscribe();
    close();
  };
}

export const Slash = memo(function Slash({ editor, insert }: Omit<ChromeProps, 'render'>) {
  const id = useId();
  const choices = useMemo(
    () =>
      insert.map((kind) =>
        entry(editor, { label: kind.label, iconPath: iconOf(kind) }, 'turnInto', (blockId) => ({
          blockId,
          type: kind.type,
          props: kind.props,
          replace: true,
        })),
      ),
    [editor, insert],
  );
  const bind = useCallback(
    (list: HTMLDivElement) => bindSlash(list, editor, choices),
    [editor, choices],
  );
  return (
    <>
      <span data-ff-announce="" aria-live="polite" />
      <div ref={bind} id={id} popover="manual" role="listbox" aria-label="Blocks" data-ff-menu="">
        {choices.map((choice, index) => (
          <div
            key={choice.label}
            id={`${id}-${index}`}
            role="option"
            aria-selected="false"
            tabIndex={-1}
          >
            <Icon path={choice.iconPath} />
            {choice.label}
          </div>
        ))}
      </div>
    </>
  );
});
