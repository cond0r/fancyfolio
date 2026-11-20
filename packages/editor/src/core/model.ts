import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Heading, Paragraph, PhrasingContent, Root, Text } from 'mdast';
import { stringifyMarkdown } from '../dialect.ts';
import type {
  Block,
  BlockId,
  Doc,
  Inline,
  Joint,
  Json,
  Leaf,
  Mark,
  MarkType,
  NoProps,
  Piece,
  Source,
} from './types.ts';

export function isCanonicalText(text: string): boolean {
  return text.isWellFormed() && !/[\r\0]/.test(text);
}

export function isRaw(type: string): boolean {
  return type === 'raw';
}

export function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function jsonOf(value: unknown, path: readonly object[] = []): Json | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || path.includes(value)) return undefined;
  const within = [...path, value];
  if (Array.isArray(value)) {
    const items: Json[] = [];
    for (const item of value) {
      const copy = jsonOf(item, within);
      if (copy === undefined) return undefined;
      items.push(copy);
    }
    return Object.freeze(items);
  }
  if (!isRecord(value)) return undefined;
  const entries: [string, Json][] = [];
  for (const [key, item] of Object.entries(value)) {
    const copy = jsonOf(item, within);
    if (copy === undefined) return undefined;
    entries.push([key, copy]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a);
  const right = new Map(Object.entries(b));
  return (
    left.length === right.size &&
    left.every(([key, value]) => {
      const other = right.get(key);
      return other !== undefined && sameJson(value, other);
    })
  );
}

export function schema<T>(accepts: (value: unknown) => value is T): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fancyfolio',
      validate: (value) =>
        accepts(value) ? { value } : { issues: [{ message: 'props fail the schema' }] },
    },
  };
}

export function hasKeys(value: unknown, keys: readonly string[]): value is object {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export const noProps = schema((value): value is NoProps => hasKeys(value, []));

export function textOf(node: Paragraph | Heading): string | undefined {
  const parts = node.children.filter((child): child is Text => child.type === 'text');
  return parts.length === node.children.length
    ? parts.map((part) => part.value).join('')
    : undefined;
}

export function textNodes(text: string): Text[] {
  return text === '' ? [] : [{ type: 'text', value: text }];
}

const wrapped = { strong: 'bold', emphasis: 'italic', delete: 'strike' } as const;

export function inlineOf(node: Paragraph | Heading): Inline | undefined {
  let text = '';
  const marks: Mark[] = [];
  const read = (children: readonly PhrasingContent[]): boolean =>
    children.every((child) => {
      const from = text.length;
      if (child.type === 'text' || child.type === 'inlineCode') {
        text += child.value;
        if (child.type === 'inlineCode') marks.push({ type: 'code', from, to: text.length });
        return true;
      }
      if (child.type === 'link') {
        if (child.title != null || !read(child.children)) return false;
        marks.push({ type: 'link', from, to: text.length, href: child.url });
        return true;
      }
      if (child.type !== 'strong' && child.type !== 'emphasis' && child.type !== 'delete') {
        return false;
      }
      if (!read(child.children)) return false;
      marks.push({ type: wrapped[child.type], from, to: text.length });
      return true;
    });
  return read(node.children) ? { text, marks } : undefined;
}

const nesting: readonly MarkType[] = ['link', 'bold', 'italic', 'strike', 'code'];

function wrap(mark: Mark, value: string, children: PhrasingContent[]): PhrasingContent {
  switch (mark.type) {
    case 'link':
      return { type: 'link', url: mark.href ?? '', children };
    case 'bold':
      return { type: 'strong', children };
    case 'italic':
      return { type: 'emphasis', children };
    case 'strike':
      return { type: 'delete', children };
    case 'code':
      return { type: 'inlineCode', value };
  }
}

export function phrasing(
  text: string,
  marks: readonly Mark[],
  leaf: Leaf = (from, to) => ({ type: 'text', value: text.slice(from, to) }),
): PhrasingContent[] {
  const cuts = [...new Set([0, text.length, ...marks.flatMap(({ from, to }) => [from, to])])];
  const sorted = cuts.toSorted((a, b) => a - b);
  const pieces = sorted.slice(1).map((to, index): Piece => ({ from: sorted[index] ?? to, to }));
  const nested = (within: readonly Piece[], depth: number): PhrasingContent[] => {
    const first = within[0];
    const last = within.at(-1);
    if (first === undefined || last === undefined) return [];
    const type = nesting[depth];
    if (type === undefined) return [leaf(first.from, last.to)];
    const groups: { mark: Mark | undefined; pieces: Piece[] }[] = [];
    for (const piece of within) {
      const mark = marks.find(
        (each) => each.type === type && each.from <= piece.from && piece.to <= each.to,
      );
      const group = groups.at(-1);
      if (group !== undefined && group.mark === mark) group.pieces.push(piece);
      else groups.push({ mark, pieces: [piece] });
    }
    return groups.flatMap(({ mark, pieces: run }) => {
      const children = nested(run, depth + 1);
      if (mark === undefined) return children;
      const value = text.slice(run[0]?.from ?? 0, run.at(-1)?.to ?? 0);
      return [wrap(mark, value, children)];
    });
  };
  return nested(pieces, 0);
}

function reference(char: string): string {
  return `&#${char.charCodeAt(0)};`;
}

function escapedUnits(text: string, joint: Joint): string[] {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => {
    const lead = line.length - line.replace(/^[\t \uFEFF]+/, '').length;
    const trail = line.replace(/[\t ]+$/, '').length;
    const units = line
      .split('')
      .map((unit, at) =>
        at < lead || at >= trail ? reference(unit) : unit.replace(/[!-/:-@[-`{-~]/, '\\$&'),
      );
    return index === 0 ? units : [joint(lines, index), ...units];
  });
}

export function escapedInline(text: string, marks: readonly Mark[], joint: Joint): string {
  const units = escapedUnits(text, joint);
  if (marks.length === 0) return units.join('');
  const children = phrasing(text, marks, (from, to) => ({
    type: 'html',
    value: units.slice(from, to).join(''),
  }));
  const root: Root = { type: 'root', children: [{ type: 'paragraph', children }] };
  return stringifyMarkdown(root).replace(/\n$/, '');
}

export function docOf(
  blocks: readonly Block[],
  sources: ReadonlyMap<BlockId, Source> = new Map(),
): Doc {
  return {
    ids: blocks.map((block) => block.id),
    blocks: new Map(blocks.map((b) => [b.id, b])),
    sources,
  };
}
