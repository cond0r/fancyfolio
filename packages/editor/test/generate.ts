import { isRaw, isSameKind } from '../src/core/model.ts';
import type { Block, BlockKind, Doc, Op } from '../src/core/types.ts';

export type Random = { int(below: number): number; pick<T>(items: readonly T[]): T };

export function seeded(seed: number): Random {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number) => Math.floor(next() * below);
  return { int, pick: (items) => items[int(items.length)] as (typeof items)[number] };
}

export function counter(prefix = 'b'): () => string {
  let next = 0;
  return () => `${prefix}${next++}`;
}

export const seeds = process.env.EDITOR_SEED
  ? [Number(process.env.EDITOR_SEED)]
  : Array.from({ length: 40 }, (_, i) => i + 1);

const pieces = [
  'a',
  'word',
  ' ',
  '  ',
  '\n',
  '\n\n',
  '\t',
  ':',
  '::metric',
  ':::note',
  '10:30',
  'Status:done',
  '#',
  '# ',
  '*',
  '_',
  '-',
  '- ',
  '1. ',
  '>',
  '`',
  '```',
  '<div>',
  '[a]',
  '[^1]',
  '|',
  '\\',
  '&amp;',
  '===',
  '---',
  'é',
  '\u00a0',
  '\\\n',
  '😀',
  'https://example.test',
];

export const kinds: readonly BlockKind[] = [
  { type: 'paragraph' },
  { type: 'paragraph' },
  { type: 'heading', level: 1 },
  { type: 'heading', level: 2 },
  { type: 'heading', level: 3 },
  { type: 'heading', level: 6 },
  { type: 'raw' },
];

export function randomText(random: Random, max = 4): string {
  return Array.from({ length: 1 + random.int(max) }, () => random.pick(pieces)).join('');
}

function boundaries(text: string): number[] {
  const offsets = [0];
  for (const char of text) offsets.push((offsets.at(-1) ?? 0) + char.length);
  return offsets;
}

function pair(random: Random, text: string): [number, number] {
  const offsets = boundaries(text);
  const a = random.pick(offsets);
  const b = random.pick(offsets);
  return a <= b ? [a, b] : [b, a];
}

function movable(from: BlockKind, text: string, to: BlockKind, kept = ''): boolean {
  if (isRaw(from) && isRaw(to) && text !== '' && kept !== '') return false;
  return text === '' || isRaw(from) === isRaw(to);
}

export function randomOp(doc: Doc, random: Random, newId: () => string, kindsAllowed = kinds): Op {
  const index = random.int(doc.ids.length);
  const id = doc.ids[index] as string;
  const block = doc.blocks.get(id) as Block;
  for (;;) {
    switch (random.int(5)) {
      case 0:
        return {
          type: 'insertText',
          id,
          offset: random.pick(boundaries(block.text)),
          text: randomText(random),
        };
      case 1: {
        const [from, to] = pair(random, block.text);
        if (from < to) return { type: 'deleteText', id, from, to };
        break;
      }
      case 2: {
        const offset = random.pick(boundaries(block.text));
        const tail = block.text.slice(offset);
        const head = block.text.slice(0, offset);
        const allowed = kindsAllowed.filter((kind) => movable(block, tail, kind, head));
        if (allowed.length > 0) {
          return { type: 'splitBlock', id, offset, newId: newId(), kind: random.pick(allowed) };
        }
        break;
      }
      case 3: {
        const previous = doc.blocks.get(doc.ids[index - 1] ?? '');
        if (previous !== undefined && movable(block, block.text, previous, previous.text)) {
          return { type: 'mergeBlocks', id };
        }
        break;
      }
      default: {
        const allowed = kindsAllowed.filter(
          (kind) => !isSameKind(kind, block) && movable(block, block.text, kind),
        );
        if (allowed.length > 0) return { type: 'setType', id, kind: random.pick(allowed) };
      }
    }
  }
}

export function docProblems(doc: Doc): string[] {
  const problems: string[] = [];
  if (doc.ids.length === 0) problems.push('no blocks');
  if (new Set(doc.ids).size !== doc.ids.length) problems.push('duplicate ids');
  if (doc.blocks.size !== doc.ids.length) problems.push('blocks outside the order');
  for (const id of doc.ids) {
    const block = doc.blocks.get(id);
    if (block === undefined || block.id !== id) {
      problems.push(`missing block ${id}`);
      continue;
    }
    if (!block.text.isWellFormed() || /[\r\0]/.test(block.text)) problems.push(`bad text ${id}`);
    if (block.type === 'heading' && ![1, 2, 3, 4, 5, 6].includes(block.level)) {
      problems.push(`bad level ${id}`);
    }
  }
  return problems;
}

export function snapshot(doc: Doc): Block[] {
  return doc.ids.map((id) => doc.blocks.get(id) as Block);
}
