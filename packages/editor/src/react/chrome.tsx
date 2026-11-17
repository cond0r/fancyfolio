import { type MouseEvent, memo, useCallback, useId, useRef } from 'react';
import { bindChrome, choose } from '../dom/chrome.ts';
import { deleteBlock } from '../dom/field.ts';
import type { ChromeProps } from './types.ts';

export const Chrome = memo(function Chrome({ editor, labelOf, render }: ChromeProps) {
  const element = useRef<HTMLDivElement>(null);
  const menu = useId();
  const bind = useCallback(
    (chrome: HTMLDivElement) => {
      element.current = chrome;
      return bindChrome(chrome, editor, labelOf);
    },
    [editor, labelOf],
  );
  const blockId = useCallback(() => element.current?.dataset.ffTarget, []);
  const remove = useCallback(
    (event: MouseEvent<HTMLButtonElement>) =>
      choose(event.currentTarget, (root, id) => deleteBlock(root, editor, id)),
    [editor],
  );
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
        <span aria-hidden="true">⋮⋮</span>
      </button>
      <div id={menu} popover="auto" role="menu" data-ff-menu="">
        <button type="button" role="menuitem" tabIndex={-1} onClick={remove}>
          Delete
        </button>
      </div>
    </>
  );
  return (
    <div ref={bind} data-ff-chrome="">
      {render === undefined ? chrome : render({ chrome, blockId })}
    </div>
  );
});
