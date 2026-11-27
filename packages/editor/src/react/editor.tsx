'use client';

import { useAtomValue } from 'jotai/react';
import { type ComponentType, useCallback, useEffect, useState } from 'react';
import type { heading } from '../core/heading.ts';
import { registryOf } from '../core/registry.ts';
import { createEditor } from '../core/store.ts';
import type {
  AnyComponent,
  Doc,
  Editor,
  OnSave,
  Presence,
  SaveState,
  Saving,
  Version,
} from '../core/types.ts';
import { bindSelection } from '../dom/chrome.ts';
import { bindEditor } from '../dom/field.ts';
import { bindPresence } from '../dom/presence.ts';
import { Block, Placeholder } from './block.tsx';
import { Chrome } from './chrome.tsx';
import { Slash } from './slash.tsx';
import { Toolbar } from './toolbar.tsx';
import type {
  AnyViews,
  EditorProps,
  Insert,
  Insertion,
  ReactEditorOptions,
  SurfaceProps,
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

function Surface({ editor, views, components, insert, onRender, renderBlockChrome }: SurfaceProps) {
  const ids = useAtomValue(editor.ids, { store: editor.store });
  const peers = useCallback((layer: HTMLDivElement) => bindPresence(layer, editor), [editor]);
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
          views={views}
          components={components}
          onRender={onRender}
        />
      ))}
      {ids.length === 0 && <Placeholder />}
      <Chrome editor={editor} insert={insert} render={renderBlockChrome} />
      <div ref={peers} data-ff-presence="" aria-hidden="true" />
      <Status editor={editor} />
      <span data-ff-live="" aria-live="polite" />
      <Slash editor={editor} insert={insert} />
      <Toolbar editor={editor} />
    </div>
  );
}

function savingOf(version: Version | undefined, onSave: OnSave | undefined): Saving {
  return version === undefined || onSave === undefined ? {} : { version, onSave };
}

const nothing: Doc = { ids: [], blocks: new Map(), sources: new Map() };

function own(editor: Editor): Omit<Presence, 'userId'> | null {
  const selection = editor.store.get(editor.selection);
  if (selection.kind !== 'text') return null;
  const { blockId, field, from, to } = selection;
  return { blockId, field, from, to };
}

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
  const base = { now: Date.now, newId: () => crypto.randomUUID(), components };
  return function ReactEditor({
    markdown,
    collab,
    onRender,
    renderBlockChrome,
    safeHref,
    version,
    onSave,
  }: EditorProps) {
    const [plain] = useState(() =>
      markdown === undefined
        ? undefined
        : createEditor(markdown, { ...base, safeHref, ...savingOf(version, onSave) }),
    );
    const [joined, setJoined] = useState<Editor>();
    useEffect(() => {
      if (collab === undefined) return;
      const editor = createEditor(nothing, {
        ...base,
        collab,
        safeHref,
        ...savingOf(version, onSave),
      });
      setJoined(editor);
      const presenting = collab.onPresence?.((others) => editor.setPresence(others));
      const publish = () => presenting?.publish(own(editor));
      const unsubscribe = editor.store.sub(editor.selection, publish);
      publish();
      return () => {
        unsubscribe();
        presenting?.stop();
        editor.disconnect();
      };
    }, [collab, safeHref, version, onSave]);
    const editor = plain ?? joined;
    return editor === undefined ? null : (
      <Surface
        editor={editor}
        views={all}
        components={registered}
        insert={insert}
        onRender={onRender}
        renderBlockChrome={renderBlockChrome}
      />
    );
  };
}
