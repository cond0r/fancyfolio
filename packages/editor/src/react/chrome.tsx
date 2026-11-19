import { type MouseEvent, memo, useCallback, useId, useMemo, useRef } from 'react';
import { childrenOf, placeOf } from '../core/tree.ts';
import type { Block, BlockId, Commands, Editor } from '../core/types.ts';
import { bindChrome, choose } from '../dom/chrome.ts';
import { bindDrag } from '../dom/drag.ts';
import { deleteBlock } from '../dom/field.ts';
import { bindOverlay } from '../dom/overlay.ts';
import { place } from '../dom/selection.ts';
import { Icon, iconOf, iconPaths } from './icons.tsx';
import type { ChromeProps, Entry, Insertion, Look } from './types.ts';

const entries = new WeakMap<Element, Entry>();

const dots = (xs: readonly number[], ys: readonly number[]) => (
  <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    {ys.flatMap((y) => xs.map((x) => <circle key={`${x} ${y}`} cx={x} cy={y} r="1.5" />))}
  </svg>
);

const sameKind = (item: Insertion, block: Block) =>
  item.type === block.type && JSON.stringify(item.props) === JSON.stringify(block.props);

const labelsOf = (insert: readonly Insertion[]) => (block: Block) =>
  (insert.find((item) => sameKind(item, block)) ?? insert.find((item) => item.type === block.type))
    ?.label ?? block.type;

function caretInFill(editor: Editor, blockId: BlockId) {
  const { store, view } = editor;
  const [fill] = childrenOf(view, blockId) ?? [];
  const block = fill === undefined ? undefined : view.blocks.get(fill);
  const [field] = Object.keys(block?.fields ?? {});
  if (store.get(editor.selection).kind !== 'blocks' || block === undefined || field === undefined) {
    return;
  }
  store.set(editor.selection, { kind: 'text', blockId: block.id, field, from: 0, to: 0 });
}

export function entry<C extends Exclude<keyof Commands, 'undo' | 'redo'>>(
  editor: Editor,
  look: Look,
  name: C,
  argsOf: (blockId: BlockId) => Commands[C] | undefined,
): Entry {
  return {
    ...look,
    can(blockId) {
      const args = argsOf(blockId);
      return args !== undefined && editor.can(name, args);
    },
    run(root, blockId) {
      const args = argsOf(blockId);
      if (args === undefined || !editor.command(name, args)) return;
      if (name === 'turnInto') caretInFill(editor, blockId);
      place(root, editor.store.get(editor.selection));
    },
  };
}

function entriesOf(editor: Editor, insert: readonly Insertion[]) {
  const moving =
    (direction: -1 | 1) =>
    (blockId: BlockId): Commands['moveBlockTo'] | undefined => {
      const at = placeOf(editor.view, blockId);
      const target =
        at === undefined ? undefined : (at.list[at.index + direction] ?? at.parent?.blockId);
      return target === undefined
        ? undefined
        : { blockId, target, side: direction < 0 ? 'before' : 'after' };
    };
  return {
    kinds: insert.map((kind) =>
      entry(editor, { label: kind.label, iconPath: iconOf(kind), kind }, 'turnInto', (blockId) => ({
        blockId,
        type: kind.type,
        props: kind.props,
        replace: false,
      })),
    ),
    actions: [
      entry(
        editor,
        { label: 'Duplicate', iconPath: iconPaths.duplicate },
        'duplicateBlock',
        (blockId) => ({ blockId }),
      ),
      entry(editor, { label: 'Move up', iconPath: iconPaths.up }, 'moveBlockTo', moving(-1)),
      entry(editor, { label: 'Move down', iconPath: iconPaths.down }, 'moveBlockTo', moving(1)),
      {
        label: 'Delete',
        iconPath: iconPaths.delete,
        hint: 'Del',
        danger: true as const,
        can: () => true,
        run: (root: HTMLElement, blockId: BlockId) => deleteBlock(root, editor, blockId),
      },
    ],
    inserts: insert.map((kind) =>
      entry(
        editor,
        { label: kind.label, iconPath: iconOf(kind) },
        'insertBlockAfter',
        (blockId) => ({ blockId, type: kind.type, props: kind.props }),
      ),
    ),
  };
}

function refresh(editor: Editor, menu: HTMLElement, blockId: BlockId) {
  const block = editor.view.blocks.get(blockId);
  for (const item of menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')) {
    const gate = entries.get(item);
    if (gate === undefined) continue;
    item.setAttribute('aria-disabled', String(!gate.can(blockId)));
    if (gate.kind !== undefined) {
      const checked = block !== undefined && sameKind(gate.kind, block);
      item.setAttribute('aria-checked', String(checked));
    }
  }
}

const Item = memo(function Item({ entry }: { readonly entry: Entry }) {
  const bind = useCallback(
    (item: HTMLButtonElement) => {
      entries.set(item, entry);
      return () => {
        entries.delete(item);
      };
    },
    [entry],
  );
  const onClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => choose(event.currentTarget, entry.run),
    [entry],
  );
  const role =
    entry.kind === undefined
      ? { role: 'menuitem' }
      : { role: 'menuitemradio', 'aria-checked': false as const };
  return (
    <button
      ref={bind}
      type="button"
      {...role}
      tabIndex={-1}
      onClick={onClick}
      data-ff-danger={entry.danger}
      data-ff-hint={entry.hint}
    >
      <Icon path={entry.iconPath} />
      {entry.label}
    </button>
  );
});

export const Chrome = memo(function Chrome({ editor, insert, render }: ChromeProps) {
  const element = useRef<HTMLDivElement>(null);
  const [menu, inserting] = [useId(), useId()];
  const { kinds, actions, inserts } = useMemo(() => entriesOf(editor, insert), [editor, insert]);
  const bind = useCallback(
    (layer: HTMLDivElement) => {
      const labelOf = labelsOf(insert);
      const overlay = bindOverlay(layer, editor, labelOf);
      const { chrome } = overlay;
      const unbind = [
        bindChrome(chrome, editor, overlay, (menu, blockId) => refresh(editor, menu, blockId)),
        bindDrag(chrome, editor, labelOf, overlay),
        overlay.unbind,
      ];
      return () => {
        for (const run of unbind) run();
      };
    },
    [editor, insert],
  );
  const blockId = useCallback(() => element.current?.dataset.ffTarget, []);
  const chrome = (
    <>
      <button
        type="button"
        data-ff-handle=""
        aria-haspopup="menu"
        aria-label="Block options"
        popoverTarget={menu}
        tabIndex={-1}
      >
        <Icon path={iconPaths.cog} />
      </button>
      <button
        type="button"
        data-ff-insert=""
        aria-haspopup="menu"
        aria-label="Insert below"
        popoverTarget={inserting}
        tabIndex={-1}
      >
        <Icon path={iconPaths.plus} />
      </button>
      <div data-ff-grip="" aria-hidden="true">
        {dots([5, 11], [3, 8, 13])}
      </div>
      <div id={menu} popover="auto" role="menu" data-ff-menu="">
        <fieldset>
          <legend>Turn into</legend>
          {kinds.map((item) => (
            <Item key={item.label} entry={item} />
          ))}
        </fieldset>
        {actions.map((item) => (
          <Item key={item.label} entry={item} />
        ))}
      </div>
      <div id={inserting} popover="auto" role="menu" data-ff-menu="">
        {inserts.map((item) => (
          <Item key={item.label} entry={item} />
        ))}
      </div>
    </>
  );
  return (
    <div ref={bind} data-ff-overlay="">
      <div ref={element} data-ff-chrome="">
        {render === undefined ? chrome : render({ chrome, blockId })}
      </div>
      <div data-ff-drop="" hidden />
    </div>
  );
});
