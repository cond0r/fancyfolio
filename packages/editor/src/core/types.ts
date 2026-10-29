import type { Atom, Store } from 'jotai/vanilla';

export type BlockId = string;

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type BlockKind =
  | { readonly type: 'paragraph' }
  | { readonly type: 'heading'; readonly level: HeadingLevel }
  | { readonly type: 'raw' };

export type Block = BlockKind & { readonly id: BlockId; readonly text: string };

export type Source = {
  readonly markdown: string;
  readonly afterId: BlockId | null;
  readonly gap: string;
  readonly trailing?: string;
};

export type Doc = {
  readonly ids: readonly BlockId[];
  readonly blocks: ReadonlyMap<BlockId, Block>;
  readonly sources: ReadonlyMap<BlockId, Source>;
};

export type DocView = {
  readonly ids: readonly BlockId[];
  readonly blocks: { get(id: BlockId): Block | undefined };
};

export type Op =
  | {
      readonly type: 'insertText';
      readonly id: BlockId;
      readonly offset: number;
      readonly text: string;
    }
  | {
      readonly type: 'deleteText';
      readonly id: BlockId;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly type: 'splitBlock';
      readonly id: BlockId;
      readonly offset: number;
      readonly newId: BlockId;
      readonly kind: BlockKind;
    }
  | { readonly type: 'mergeBlocks'; readonly id: BlockId }
  | { readonly type: 'setType'; readonly id: BlockId; readonly kind: BlockKind };

export type Change = {
  readonly put: readonly Block[];
  readonly ids?: readonly BlockId[];
  readonly drop: readonly BlockId[];
};

export type Step = {
  readonly op: Op;
  readonly inverse: Op;
  readonly started: number;
  readonly at: number;
};

export type History = {
  readonly done: readonly Step[];
  readonly undone: readonly Step[];
  readonly sealed: boolean;
};

export type Travel = { readonly history: History; readonly op: Op; readonly inverse: Op };

export type Editor = {
  readonly store: Store;
  readonly ids: Atom<readonly BlockId[]>;
  readonly blocks: ReadonlyMap<BlockId, Atom<Block>>;
  dispatch(op: Op): void;
  undo(): boolean;
  redo(): boolean;
  doc(): Doc;
  markdown(): SaveResult;
};

export type EditorOptions = {
  readonly now: () => number;
  readonly newId: () => BlockId;
};

export type SaveResult =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly reason: 'misread'; readonly blockId: BlockId }
  | { readonly ok: false; readonly reason: 'guard' };

export type Read = (BlockKind & { readonly text: string }) | null;

export type Part = {
  readonly block: Block;
  readonly gap: string;
  readonly markdown: string;
  readonly verbatim: boolean;
};

export type Verdict =
  | SaveResult
  | { readonly ok: false; readonly reason: 'unread'; readonly ids: ReadonlySet<BlockId> };
