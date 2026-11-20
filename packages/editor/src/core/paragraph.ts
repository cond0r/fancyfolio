import { escapedInline, inlineOf, noProps, phrasing } from './model.ts';
import type { Component, NoProps } from './types.ts';

export const paragraph: Component<'paragraph', NoProps, 'text'> = {
  name: 'paragraph',
  props: noProps,
  fields: ['text'],
  labels: { text: 'Paragraph' },
  marks: ['text'],
  markdown: {
    match: 'paragraph',
    read(node) {
      if (node.type !== 'paragraph') return undefined;
      const inline = inlineOf(node);
      return inline && { props: {}, fields: { text: inline.text }, marks: { text: inline.marks } };
    },
    write: (block) => ({
      type: 'paragraph',
      children: phrasing(block.fields.text, block.marks?.text ?? []),
    }),
    escaped: (block) =>
      escapedInline(block.fields.text, block.marks?.text ?? [], (lines, index) =>
        lines[index] === '' || lines[index - 1] === '' ? '&#10;' : '\n',
      ),
  },
};
