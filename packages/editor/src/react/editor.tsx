'use client';

import { useAtomValue } from 'jotai/react';
import { type ComponentType, useCallback, useState } from 'react';
import type { heading } from '../core/heading.ts';
import { registryOf } from '../core/registry.ts';
import { createEditor } from '../core/store.ts';
import type { AnyComponent, Block as BlockData, Editor, SaveState } from '../core/types.ts';
import { bindSelection } from '../dom/chrome.ts';
import { bindEditor } from '../dom/field.ts';
import { Block } from './block.tsx';
import { Chrome } from './chrome.tsx';
import type {
  AnyViews,
  EditorProps,
  Insert,
  Insertion,
  ReactEditorOptions,
  ViewMap,
  Views,
} from './types.ts';
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

const texts: Insert<readonly []> = [
  { type: 'paragraph', props: {}, label: 'Text' },
  { type: 'heading', props: { level: 1 }, label: 'Heading 1' },
  { type: 'heading', props: { level: 2 }, label: 'Heading 2' },
  { type: 'heading', props: { level: 3 }, label: 'Heading 3' },
];

const labelsOf = (insert: readonly Insertion[]) => (block: BlockData) => {
  const same = insert.filter((item) => item.type === block.type);
  const props = JSON.stringify(block.props);
  return (
    (same.find((item) => JSON.stringify(item.props) === props) ?? same[0])?.label ?? block.type
  );
};

export function createReactEditor<const P extends readonly AnyComponent[]>(
  options: ReactEditorOptions<P>,
): ComponentType<EditorProps>;
export function createReactEditor({
  components,
  views,
  insert = texts,
}: {
  readonly components: readonly AnyComponent[];
  readonly views: AnyViews;
  readonly insert?: readonly Insertion[];
}): ComponentType<EditorProps> {
  const all: ViewMap = new Map(Object.entries({ ...builtins, ...views }));
  const registered = registryOf(components).components;
  const labelOf = labelsOf(insert);
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
    const bind = useCallback(
      (root: HTMLDivElement) => {
        const unbind = [bindEditor(root, editor), bindSelection(root, editor)];
        return () => {
          for (const run of unbind) run();
        };
      },
      [editor],
    );
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
          />
        ))}
        <Chrome editor={editor} labelOf={labelOf} render={renderBlockChrome} />
        <Status editor={editor} />
        <span data-ff-live="" aria-live="polite" />
      </div>
    );
  };
}
