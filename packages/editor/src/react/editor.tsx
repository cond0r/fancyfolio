'use client';

import { useAtomValue } from 'jotai/react';
import { type ComponentType, useCallback, useState } from 'react';
import type { heading } from '../core/heading.ts';
import { registryOf } from '../core/registry.ts';
import { createEditor } from '../core/store.ts';
import type { AnyComponent, Editor, SaveState } from '../core/types.ts';
import { bindEditor } from '../dom/field.ts';
import { Block } from './block.tsx';
import type { AnyViews, EditorProps, ReactEditorOptions, ViewMap, Views } from './types.ts';
import { Heading, Paragraph, Raw } from './views.tsx';

function viewsOf<P extends readonly AnyComponent[]>(views: Views<P>): AnyViews;
function viewsOf(views: AnyViews): AnyViews {
  return views;
}

const messages: { readonly [S in SaveState]: string } = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  stale: 'Not saved: a newer version exists',
  failed: 'Not saved',
};

function Status({ editor }: { readonly editor: Editor }) {
  const state = useAtomValue(editor.saveState, { store: editor.store });
  return <output aria-live="polite">{messages[state]}</output>;
}

const builtins: AnyViews = {
  ...viewsOf<readonly [typeof heading]>({ heading: Heading }),
  paragraph: Paragraph,
  raw: Raw,
};

export function createReactEditor<const P extends readonly AnyComponent[]>(
  options: ReactEditorOptions<P>,
): ComponentType<EditorProps>;
export function createReactEditor({
  components,
  views,
}: {
  readonly components: readonly AnyComponent[];
  readonly views: AnyViews;
}): ComponentType<EditorProps> {
  const all: ViewMap = new Map(Object.entries({ ...builtins, ...views }));
  const registered = registryOf(components).components;
  return function ReactEditor({ markdown, onRender, renderBlockChrome, ...saving }: EditorProps) {
    const [editor] = useState(() =>
      createEditor(markdown, {
        now: Date.now,
        newId: () => crypto.randomUUID(),
        components,
        ...saving,
      }),
    );
    const ids = useAtomValue(editor.ids, { store: editor.store });
    const bind = useCallback((root: HTMLDivElement) => bindEditor(root, editor), [editor]);
    return (
      <div ref={bind} data-ff-editor="" tabIndex={-1}>
        {ids.map((id) => (
          <Block
            key={id}
            id={id}
            editor={editor}
            views={all}
            components={registered}
            onRender={onRender}
            renderBlockChrome={renderBlockChrome}
          />
        ))}
        <Status editor={editor} />
      </div>
    );
  };
}
