import type { ComponentType, ReactNode } from 'react';
import type {
  AnyComponent,
  Block,
  BlockId,
  BlockOf,
  CollabAdapter,
  Editor,
  HeadingProps,
  Json,
  MarkType,
  NoProps,
  Registered,
  SafeHref,
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

export type Insertion = {
  readonly type: string;
  readonly props: Json;
  readonly label: string;
  readonly iconPath?: string;
};

type Insertable<B> = B extends { readonly type: infer T; readonly props: infer Props }
  ? { readonly type: T; readonly props: Props; readonly label: string; readonly iconPath?: string }
  : never;

export type Insert<P extends readonly AnyComponent[]> = readonly Insertable<
  | BlockOf<P>
  | (TypedBlock<NoProps, 'text'> & { readonly type: 'paragraph' })
  | (TypedBlock<HeadingProps, 'text'> & { readonly type: 'heading' })
>[];

export type ReactEditorOptions<P extends readonly AnyComponent[]> = {
  readonly components: P;
  readonly views: Views<P> & BuiltinViews;
  readonly insert?: Insert<P>;
};

export type BlockChrome = {
  readonly chrome: ReactNode;
  blockId(): BlockId | undefined;
};

export type RenderBlockChrome = (chrome: BlockChrome) => ReactNode;

export type EditorProps = {
  readonly onRender?: (blockId: BlockId) => void;
  readonly renderBlockChrome?: RenderBlockChrome;
  readonly safeHref?: SafeHref;
} & (
  | { readonly markdown: string; readonly collab?: undefined }
  | { readonly collab: CollabAdapter; readonly markdown?: undefined }
) &
  Saving;

export type SurfaceProps = {
  readonly editor: Editor;
  readonly views: ViewMap;
  readonly components: ReadonlyMap<string, Registered>;
  readonly insert: readonly Insertion[];
  readonly onRender: ((blockId: BlockId) => void) | undefined;
  readonly renderBlockChrome: RenderBlockChrome | undefined;
};

export type ViewMap = ReadonlyMap<string, ComponentType<ViewProps<Block>>>;

export type BlockProps = {
  readonly id: BlockId;
  readonly editor: Editor;
  readonly views: ViewMap;
  readonly components: ReadonlyMap<string, Registered>;
  readonly onRender: ((blockId: BlockId) => void) | undefined;
};

export type ChromeProps = {
  readonly editor: Editor;
  readonly insert: readonly Insertion[];
  readonly render: RenderBlockChrome | undefined;
};

export type Look = {
  readonly label: string;
  readonly iconPath: string;
  readonly kind?: Insertion;
  readonly hint?: string;
  readonly danger?: true;
};

export type Entry = Look & {
  can(blockId: BlockId): boolean;
  run(root: HTMLElement, blockId: BlockId): void;
};

export type Open = {
  readonly blockId: BlockId;
  readonly field: HTMLElement;
  readonly allowed: readonly number[];
  text: string;
  shown: readonly number[];
  active: number;
};

export type FieldProps = {
  readonly editor: Editor;
  readonly blockId: BlockId;
  readonly field: string;
  readonly label: string | undefined;
};

export type Toggle = {
  readonly mark: Exclude<MarkType, 'link' | 'color'>;
  readonly label: string;
  readonly keys: string;
};
