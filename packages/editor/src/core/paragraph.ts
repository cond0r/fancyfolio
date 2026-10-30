import { escapedLines, noProps, textNodes, textOf } from './model.ts';
import type { Component, NoProps } from './types.ts';

export const paragraph: Component<'paragraph', NoProps, 'text'> = {
  name: 'paragraph',
  props: noProps,
  fields: ['text'],
  markdown: {
    match: 'paragraph',
    read(node) {
      if (node.type !== 'paragraph') return undefined;
      const text = textOf(node);
      return text === undefined ? undefined : { props: {}, fields: { text } };
    },
    write: (block) => ({ type: 'paragraph', children: textNodes(block.fields.text) }),
    escaped(block) {
      const lines = escapedLines(block.fields.text);
      return lines.reduce((joined, line, index) => {
        const blank = line === '' || lines[index - 1] === '';
        return index === 0 ? line : `${joined}${blank ? '&#10;' : '\n'}${line}`;
      }, '');
    },
  },
};
