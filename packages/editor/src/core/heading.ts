import { escapedLines, hasKeys, schema, textNodes, textOf } from './model.ts';
import type { Component, HeadingLevel, HeadingProps } from './types.ts';

function isLevel(level: unknown): level is HeadingLevel {
  return typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6;
}

export const heading: Component<'heading', HeadingProps, 'text'> = {
  name: 'heading',
  props: schema(
    (value): value is HeadingProps =>
      hasKeys(value, ['level']) && isLevel(Reflect.get(value, 'level')),
  ),
  fields: ['text'],
  markdown: {
    match: 'heading',
    read(node) {
      if (node.type !== 'heading') return undefined;
      const text = textOf(node);
      return text === undefined ? undefined : { props: { level: node.depth }, fields: { text } };
    },
    write: (block) => ({
      type: 'heading',
      depth: block.props.level,
      children: textNodes(block.fields.text),
    }),
    escaped(block) {
      const text = escapedLines(block.fields.text).join('&#10;');
      return `${'#'.repeat(block.props.level)}${text === '' ? '' : ` ${text}`}`;
    },
  },
};
