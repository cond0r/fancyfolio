import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
  BlockContent,
  DefinitionContent,
  Paragraph,
  PhrasingContent,
  RootContent,
} from 'mdast';
import { parseMarkdown, stringifyMarkdown } from '../dialect.ts';
import { escapedInline, inlineOf, phrasing, textNodes, textOf } from './model.ts';
import type { Codec, Container, Directive, Inline, Mark, TypedBlock } from './types.ts';

function covers<Key extends string, Value>(
  value: { readonly [key: string]: Value },
  keys: readonly Key[],
): value is { readonly [key: string]: Value } & { readonly [K in Key]: Value } {
  return keys.every((key) => Object.hasOwn(value, key));
}

function validated<Props>(schema: StandardSchemaV1<unknown, Props>, value: unknown) {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    result.catch(() => undefined);
    return undefined;
  }
  return result.issues === undefined ? { props: result.value } : undefined;
}

function fieldNames<Props, Field extends string>(spec: Directive<Props, Field>): readonly Field[] {
  return spec.label === undefined ? spec.attributes : [...spec.attributes, spec.label];
}

function readParts<Props, Field extends string>(
  spec: Directive<Props, Field>,
  attributes: { readonly [key: string]: string | null | undefined } | null | undefined,
  label: string | undefined,
) {
  if (label === undefined || (spec.label === undefined && label !== '')) return undefined;
  const known = new Set<string>([...spec.keys, ...spec.attributes]);
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (!known.has(key) || typeof value !== 'string') return undefined;
    values.set(key, value);
  }
  const read = validated(
    spec.props,
    Object.fromEntries(
      spec.keys.flatMap((key) => (values.has(key) ? [[key, values.get(key)]] : [])),
    ),
  );
  const texts: [string, string][] = [];
  const marks: { [F in Field]?: readonly Mark[] } = {};
  for (const name of spec.attributes) {
    const value = values.get(name) ?? '';
    const inline = spec.inline?.includes(name) ? inlineIn(value) : { text: value, marks: [] };
    if (inline === undefined) return undefined;
    texts.push([name, inline.text]);
    if (inline.marks.length > 0) marks[name] = inline.marks;
  }
  if (spec.label !== undefined) texts.push([spec.label, label]);
  const fields = Object.fromEntries(texts);
  if (read === undefined || !covers(fields, fieldNames(spec))) return undefined;
  return { props: read.props, fields, marks };
}

function inlineIn(value: string): Inline | undefined {
  const nodes = parseMarkdown(value).children;
  const [only] = nodes;
  if (only === undefined) return { text: '', marks: [] };
  return nodes.length === 1 && only.type === 'paragraph'
    ? inlineOf(only)
    : { text: value, marks: [] };
}

function inlineSource(text: string, marks: readonly Mark[]): string {
  const paragraph: Paragraph = { type: 'paragraph', children: phrasing(text, marks) };
  return stringifyMarkdown({ type: 'root', children: [paragraph] }).replace(/\n$/, '');
}

function inlineEscaped(text: string, marks: readonly Mark[]): string {
  return escapedInline(text, marks, () => '&#10;');
}

function attributeText(text: string): string {
  return text.replaceAll('&', '&amp;');
}

function labelText(text: string): string {
  // mdast-util-directive leaves inline markup in a label unescaped
  return text.replace(/[&*<_`~]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function attributesOf<Props, Field extends string, Slot extends string>(
  spec: Directive<Props, Field>,
  block: TypedBlock<Props, Field, Slot>,
  inline = inlineSource,
): { readonly [key: string]: string } {
  const entries: [string, string][] = [];
  for (const key of spec.keys) {
    const value = block.props[key];
    if (typeof value === 'string') entries.push([key, attributeText(value)]);
  }
  for (const name of spec.attributes) {
    const text = block.fields[name];
    if (text === '') continue;
    const source = spec.inline?.includes(name) ? inline(text, block.marks?.[name] ?? []) : text;
    entries.push([name, attributeText(source)]);
  }
  return Object.fromEntries(entries);
}

function labelOf<Props, Field extends string, Slot extends string>(
  spec: Directive<Props, Field>,
  block: TypedBlock<Props, Field, Slot>,
): PhrasingContent[] {
  return spec.label === undefined ? [] : textNodes(labelText(block.fields[spec.label]));
}

export function leafDirective<Props, const Field extends string>(
  spec: Directive<Props, Field>,
): Codec<Props, Field> {
  const written = (block: TypedBlock<Props, Field>, inline = inlineSource): RootContent => ({
    type: 'leafDirective',
    name: spec.name,
    attributes: attributesOf(spec, block, inline),
    children: labelOf(spec, block),
  });
  return {
    match: `leafDirective:${spec.name}`,
    read(node) {
      if (node.type !== 'leafDirective' || node.name !== spec.name) return undefined;
      return readParts(
        spec,
        node.attributes,
        textOf({ type: 'paragraph', children: node.children }),
      );
    },
    write: (block) => written(block),
    ...(spec.inline !== undefined && {
      escaped: (block) =>
        stringifyMarkdown({ type: 'root', children: [written(block, inlineEscaped)] }).replace(
          /\n$/,
          '',
        ),
    }),
  };
}

export function containerDirective<Props, const Field extends string, const Slot extends string>(
  spec: Container<Props, Field, Slot>,
): Codec<Props, Field, Slot> {
  return {
    match: `containerDirective:${spec.name}`,
    read(node) {
      if (node.type !== 'containerDirective' || node.name !== spec.name) return undefined;
      const [first, ...rest] = node.children;
      const labelled = first?.type === 'paragraph' && first.data?.directiveLabel === true;
      const read = readParts(spec, node.attributes, labelled ? textOf(first) : '');
      const slots = { [spec.slot]: labelled ? rest : node.children };
      return read === undefined || !covers(slots, [spec.slot]) ? undefined : { ...read, slots };
    },
    write(block, slots) {
      const label = labelOf(spec, block);
      const titled: Paragraph[] =
        label.length === 0
          ? []
          : [{ type: 'paragraph', data: { directiveLabel: true }, children: label }];
      const children: (BlockContent | DefinitionContent)[] = [...titled, ...slots[spec.slot]];
      return {
        type: 'containerDirective',
        name: spec.name,
        attributes: attributesOf(spec, block),
        children,
      };
    },
  };
}
