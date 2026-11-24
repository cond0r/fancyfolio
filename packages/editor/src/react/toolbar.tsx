import { memo, useCallback, useId } from 'react';
import type { Case, Editor } from '../core/types.ts';
import { colors } from '../dialect.ts';
import { bindToolbar } from '../dom/toolbar.ts';
import { Icon, iconPaths } from './icons.tsx';
import type { Toggle } from './types.ts';

const toggles: readonly Toggle[] = [
  { mark: 'bold', label: 'Bold', keys: 'Control+B Meta+B' },
  { mark: 'italic', label: 'Italic', keys: 'Control+I Meta+I' },
  { mark: 'strike', label: 'Strikethrough', keys: 'Control+Shift+X Meta+Shift+X' },
  { mark: 'highlight', label: 'Highlight', keys: 'Control+Shift+H Meta+Shift+H' },
  { mark: 'code', label: 'Code', keys: 'Control+E Meta+E' },
];

const cases: readonly { readonly to: Case; readonly label: string }[] = [
  { to: 'upper', label: 'UPPERCASE' },
  { to: 'lower', label: 'lowercase' },
  { to: 'capitalize', label: 'Capitalize Words' },
];

const colourAt = toggles.findIndex(({ mark }) => mark === 'code');

const tones = [
  { tone: '', label: 'Default' },
  ...Object.keys(colors).map((tone) => ({
    tone,
    label: `${tone.charAt(0).toUpperCase()}${tone.slice(1)}`,
  })),
];

function toggle({ mark, label, keys }: Toggle) {
  return (
    <button
      key={mark}
      type="button"
      data-ff-mark={mark}
      aria-label={label}
      aria-keyshortcuts={keys}
      aria-pressed="false"
      tabIndex={mark === 'bold' ? 0 : -1}
    >
      <Icon path={iconPaths[mark]} />
    </button>
  );
}

export const Toolbar = memo(function Toolbar({ editor }: { readonly editor: Editor }) {
  const [menu, palette, error] = [useId(), useId(), useId()];
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
        {toggles.slice(0, colourAt).map(toggle)}
        <button
          type="button"
          aria-label="Text colour"
          aria-haspopup="menu"
          popoverTarget={palette}
          tabIndex={-1}
        >
          A<span data-ff-swatch="" />
        </button>
        {toggles.slice(colourAt).map(toggle)}
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
      <div id={palette} popover="auto" role="menu" aria-label="Text colour" data-ff-menu="">
        {tones.map(({ tone, label }) => (
          <button
            key={label}
            type="button"
            role="menuitemradio"
            aria-checked="false"
            data-ff-tone={tone}
            tabIndex={-1}
          >
            <span data-ff-swatch="" data-ff-color={tone || undefined} />
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
