import type { Block, HeadingProps, TypedBlock } from '../core/types.ts';
import type { ViewProps } from './types.ts';

const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

export function Paragraph({ fields }: ViewProps<Block>) {
  return <p>{fields.text}</p>;
}

export function Heading({ props, fields }: ViewProps<TypedBlock<HeadingProps, 'text'>>) {
  const Tag = headings[props.level - 1];
  return <Tag>{fields.text}</Tag>;
}

export function Raw({ fields }: ViewProps<Block>) {
  return <pre>{fields.text}</pre>;
}
