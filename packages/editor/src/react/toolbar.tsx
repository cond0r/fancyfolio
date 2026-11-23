import { memo, useCallback, useId } from 'react';
import type { Case, Editor, MarkType } from '../core/types.ts';
import { bindToolbar } from '../dom/toolbar.ts';
import { Icon, iconPaths } from './icons.tsx';

const toggles: readonly {
  readonly mark: Exclude<MarkType, 'link'>;
  readonly label: string;
  readonly keys: string;
}[] = [
  { mark: 'bold', label: 'Bold', keys: 'Control+B Meta+B' },
  { mark: 'italic', label: 'Italic', keys: 'Control+I Meta+I' },
  { mark: 'strike', label: 'Strikethrough', keys: 'Control+Shift+X Meta+Shift+X' },
  { mark: 'code', label: 'Code', keys: 'Control+E Meta+E' },
];

const cases: readonly { readonly to: Case; readonly label: string }[] = [
  { to: 'upper', label: 'UPPERCASE' },
  { to: 'lower', label: 'lowercase' },
  { to: 'capitalize', label: 'Capitalize Words' },
];

export const Toolbar = memo(function Toolbar({ editor }: { readonly editor: Editor }) {
  const [menu, error] = [useId(), useId()];
  const bind = useCallback((bar: HTMLDivElement) => bindToolbar(bar, editor), [editor]);
  return (
    <div
      ref={bind}
      role="toolbar"
      aria-label="Text formatting"
      popover="manual"
      data-ff-toolbar=""
      hidden
    >
      <div data-ff-tools="">
        {toggles.map(({ mark, label, keys }, index) => (
          <button
            key={mark}
            type="button"
            data-ff-mark={mark}
            aria-label={label}
            aria-keyshortcuts={keys}
            aria-pressed="false"
            tabIndex={index === 0 ? 0 : -1}
          >
            <Icon path={iconPaths[mark]} />
          </button>
        ))}
        <button
          type="button"
          data-ff-linker=""
          aria-label="Link"
          aria-keyshortcuts="Control+K Meta+K"
          aria-pressed="false"
          tabIndex={-1}
        >
          <Icon path={iconPaths.link} />
        </button>
        <button
          type="button"
          aria-label="Change case"
          aria-haspopup="menu"
          popoverTarget={menu}
          tabIndex={-1}
        >
          Aa
        </button>
      </div>
      <div id={menu} popover="auto" role="menu" aria-label="Change case" data-ff-menu="">
        {cases.map(({ to, label }) => (
          <button key={to} type="button" role="menuitem" data-ff-case={to} tabIndex={-1}>
            {label}
          </button>
        ))}
      </div>
      <form data-ff-link-form="" noValidate hidden>
        <input type="url" aria-label="Link URL" aria-describedby={error} placeholder="https://" />
        <button type="button" data-ff-unlink="">
          Remove link
        </button>
      </form>
      <span id={error} data-ff-error="" aria-live="polite" />
    </div>
  );
});
