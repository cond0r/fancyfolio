import type { Block, BlockId, BlockKind, Doc, Source } from './types.ts';

export function isCanonicalText(text: string): boolean {
  return text.isWellFormed() && !/[\r\0]/.test(text);
}

export function isRaw(kind: BlockKind): boolean {
  return kind.type === 'raw';
}

export function kindOf(block: Block): BlockKind {
  return block.type === 'heading' ? { type: 'heading', level: block.level } : { type: block.type };
}

export function isSameKind(a: BlockKind, b: BlockKind): boolean {
  return (
    a.type === b.type && (a.type !== 'heading' || (b.type === 'heading' && a.level === b.level))
  );
}

export function withKind(kind: BlockKind, id: BlockId, text: string): Block {
  return kind.type === 'heading'
    ? { type: 'heading', level: kind.level, id, text }
    : { type: kind.type, id, text };
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
