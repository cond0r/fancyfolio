import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Heading, Paragraph, Text } from 'mdast';
import type { Block, BlockId, Doc, Json, NoProps, Source } from './types.ts';

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

function reference(char: string): string {
  return `&#${char.charCodeAt(0)};`;
}

export function escapedLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/[!-/:-@[-`{-~]/g, '\\$&')
        .replace(/^[\t ﻿]+|[\t ]+$/g, (edge) => [...edge].map(reference).join('')),
    );
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
