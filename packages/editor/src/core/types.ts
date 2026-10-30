import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Atom, Store } from 'jotai/vanilla';
import type { RootContent } from 'mdast';

export type BlockId = string;

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export type Fields = { readonly [field: string]: string };

export type BlockKind = { readonly type: string; readonly props: Json };

export type Block = BlockKind & { readonly id: BlockId; readonly fields: Fields };

export type TypedBlock<Props, Field extends string> = {
  readonly id: BlockId;
  readonly type: string;
  readonly props: Props;
  readonly fields: { readonly [F in Field]: string };
};

export type Codec<Props, Field extends string> = {
  readonly match:
    | 'paragraph'
    | 'heading'
    | `leafDirective:${string}`
    | `containerDirective:${string}`;
  read(
    node: RootContent,
  ): { readonly props: Props; readonly fields: { readonly [F in Field]: string } } | undefined;
  write(block: TypedBlock<Props, Field>): RootContent;
  escaped?(block: TypedBlock<Props, Field>): string;
};

export type Component<Name extends string, Props, Field extends string> = {
  readonly name: Name;
  readonly props: StandardSchemaV1<unknown, Props>;
  readonly fields: readonly Field[];
  readonly markdown: Codec<Props, Field>;
};

export type AnyComponent = Component<string, unknown, string>;

export type NoProps = { readonly [key: string]: never };

export type HeadingProps = { readonly level: HeadingLevel };

export type Fallback = Omit<Component<'raw', NoProps, 'text'>, 'markdown'>;

export type Registered = Omit<AnyComponent, 'markdown'> & {
  readonly markdown?: AnyComponent['markdown'];
};

export type Registry = {
  readonly components: ReadonlyMap<string, Registered>;
  readonly matches: ReadonlyMap<string, AnyComponent>;
};

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
      readonly kind: 'insertText';
      readonly blockId: BlockId;
      readonly field: string;
      readonly offset: number;
      readonly text: string;
    }
  | {
      readonly kind: 'deleteText';
      readonly blockId: BlockId;
      readonly field: string;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly kind: 'splitBlock';
      readonly blockId: BlockId;
      readonly field: string;
      readonly offset: number;
      readonly newId: BlockId;
      readonly type: string;
      readonly props: Json;
    }
  | { readonly kind: 'mergeBlocks'; readonly blockId: BlockId }
  | {
      readonly kind: 'setType';
      readonly blockId: BlockId;
      readonly type: string;
      readonly props: Json;
    };

export type Change = {
  readonly put: readonly Block[];
  readonly ids?: readonly BlockId[];
  readonly drop: readonly BlockId[];
};

export type Planned = { readonly op: Op; readonly change: Change; readonly inverse: Op };

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
  readonly components?: readonly AnyComponent[];
};

export type SaveResult =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly reason: 'misread'; readonly blockId: BlockId }
  | { readonly ok: false; readonly reason: 'guard' };

export type Read = (BlockKind & { readonly fields: Fields }) | null;

export type Part = {
  readonly block: Block;
  readonly gap: string;
  readonly markdown: string;
  readonly verbatim: boolean;
};

export type Verdict =
  | SaveResult
  | { readonly ok: false; readonly reason: 'unread'; readonly ids: ReadonlySet<BlockId> };
