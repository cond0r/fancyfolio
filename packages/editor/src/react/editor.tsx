'use client';

import { useAtomValue } from 'jotai/react';
import { type ComponentType, useCallback, useState } from 'react';
import type { heading } from '../core/heading.ts';
import { createEditor } from '../core/store.ts';
import type { AnyComponent } from '../core/types.ts';
import { bindEditor } from '../dom/field.ts';
import { Block } from './block.tsx';
import type { AnyViews, EditorProps, ReactEditorOptions, ViewMap, Views } from './types.ts';
import { Heading, Paragraph, Raw } from './views.tsx';

function viewsOf<P extends readonly AnyComponent[]>(views: Views<P>): AnyViews;
function viewsOf(views: AnyViews): AnyViews {
  return views;
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
  const all: ViewMap = new Map(Object.entries({ ...views, ...builtins }));
  return function ReactEditor({ markdown, onRender }: EditorProps) {
    const [editor] = useState(() =>
      createEditor(markdown, { now: Date.now, newId: () => crypto.randomUUID(), components }),
    );
    const ids = useAtomValue(editor.ids, { store: editor.store });
    const bind = useCallback((root: HTMLDivElement) => bindEditor(root, editor), [editor]);
    return (
      <div ref={bind} data-ff-editor="" tabIndex={-1}>
        {ids.map((id) => (
          <Block key={id} id={id} editor={editor} views={all} onRender={onRender} />
        ))}
      </div>
    );
  };
}
