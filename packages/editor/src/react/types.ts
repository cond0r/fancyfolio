import type { ComponentType, ReactNode } from 'react';
import type {
  AnyComponent,
  Block,
  BlockId,
  BlockOf,
  Editor,
  HeadingProps,
  NoProps,
  Registered,
  Saving,
  TypedBlock,
} from '../core/types.ts';

export type ViewProps<B extends TypedBlock<unknown, string>> = {
  readonly props: B['props'];
  readonly fields: { readonly [F in keyof B['fields']]: ReactNode };
  readonly slots: { readonly [S in keyof NonNullable<B['slots']>]: ReactNode };
};

export type Views<P extends readonly AnyComponent[]> = {
  readonly [B in BlockOf<P> as B['type']]: ComponentType<ViewProps<B>>;
};

export type AnyViews = { readonly [type: string]: ComponentType<ViewProps<Block>> };

export type BuiltinViews = {
  readonly paragraph?: ComponentType<ViewProps<TypedBlock<NoProps, 'text'>>>;
  readonly heading?: ComponentType<ViewProps<TypedBlock<HeadingProps, 'text'>>>;
  readonly raw?: ComponentType<ViewProps<TypedBlock<NoProps, 'text'>>>;
};

export type ReactEditorOptions<P extends readonly AnyComponent[]> = {
  readonly components: P;
  readonly views: Views<P> & BuiltinViews;
};

export type BlockChrome = {
  readonly blockId: BlockId;
  readonly selected: boolean;
  remove(): void;
};

export type RenderBlockChrome = (chrome: BlockChrome) => ReactNode;

export type EditorProps = {
  readonly markdown: string;
  readonly onRender?: (blockId: BlockId) => void;
  readonly renderBlockChrome?: RenderBlockChrome;
} & Saving;

export type ViewMap = ReadonlyMap<string, ComponentType<ViewProps<Block>>>;

export type BlockProps = {
  readonly id: BlockId;
  readonly editor: Editor;
  readonly views: ViewMap;
  readonly components: ReadonlyMap<string, Registered>;
  readonly onRender: ((blockId: BlockId) => void) | undefined;
  readonly renderBlockChrome: RenderBlockChrome | undefined;
};

export type FieldProps = {
  readonly editor: Editor;
  readonly blockId: BlockId;
  readonly field: string;
  readonly label: string | undefined;
};
