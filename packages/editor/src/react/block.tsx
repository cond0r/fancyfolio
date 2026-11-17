import { useAtomValue } from 'jotai/react';
import { memo, useCallback, useEffect } from 'react';
import type { BlockId, Editor } from '../core/types.ts';
import { flagSelected } from '../dom/chrome.ts';
import { bindField } from '../dom/field.ts';
import type { BlockProps, FieldProps } from './types.ts';
import { Raw } from './views.tsx';

function atomOf(editor: Editor, id: BlockId) {
  const block = editor.blocks.get(id);
  if (block === undefined) throw new Error(`block ${id} has no atom`);
  return block;
}

const Field = memo(function Field({ editor, blockId, field, label }: FieldProps) {
  const bind = useCallback(
    (element: HTMLSpanElement) => bindField(element, editor, blockId, field),
    [editor, blockId, field],
  );
  return (
    <span
      ref={bind}
      role="textbox"
      tabIndex={0}
      aria-label={label}
      aria-keyshortcuts="Control+/ Meta+/"
      contentEditable
      suppressContentEditableWarning
      data-field={field}
    />
  );
});

export const Block = memo(function Block({ id, editor, views, components, onRender }: BlockProps) {
  const block = useAtomValue(atomOf(editor, id), { store: editor.store });
  const flag = useCallback(
    (element: HTMLDivElement | null) => {
      if (element !== null) flagSelected(element, editor);
    },
    [editor],
  );
  useEffect(() => {
    onRender?.(id);
  });
  const View = views.get(block.type) ?? Raw;
  const labels = components.get(block.type)?.labels;
  const fields = Object.fromEntries(
    Object.keys(block.fields).map((field) => [
      field,
      <Field key={field} editor={editor} blockId={id} field={field} label={labels?.[field]} />,
    ]),
  );
  const slots = Object.fromEntries(
    Object.entries(block.slots ?? {}).map(([slot, ids]) => [
      slot,
      ids.map((child) => (
        <Block
          key={child}
          id={child}
          editor={editor}
          views={views}
          components={components}
          onRender={onRender}
        />
      )),
    ]),
  );
  return (
    <div ref={flag} data-block-id={id}>
      <View props={block.props} fields={fields} slots={slots} />
    </div>
  );
});
