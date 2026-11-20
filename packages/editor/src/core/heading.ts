import { escapedInline, hasKeys, inlineOf, phrasing, schema } from './model.ts';
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
  labels: { text: 'Heading' },
  marks: ['text'],
  markdown: {
    match: 'heading',
    read(node) {
      if (node.type !== 'heading') return undefined;
      const inline = inlineOf(node);
      return (
        inline && {
          props: { level: node.depth },
          fields: { text: inline.text },
          marks: { text: inline.marks },
        }
      );
    },
    write: (block) => ({
      type: 'heading',
      depth: block.props.level,
      children: phrasing(block.fields.text, block.marks?.text ?? []),
    }),
    escaped(block) {
      const text = escapedInline(block.fields.text, block.marks?.text ?? [], () => '&#10;');
      return `${'#'.repeat(block.props.level)}${text === '' ? '' : ` ${text}`}`;
    },
  },
};
