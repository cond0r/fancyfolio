import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Atom, PrimitiveAtom, Store } from 'jotai/vanilla';
import type { BlockContent, DefinitionContent, RootContent } from 'mdast';

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

export type Slots = { readonly [slot: string]: readonly BlockId[] };

export type Block = BlockKind & {
  readonly id: BlockId;
  readonly fields: Fields;
  readonly slots?: Slots;
};

export type TypedBlock<Props, Field extends string, Slot extends string = never> = {
  readonly id: BlockId;
  readonly type: string;
  readonly props: Props;
  readonly fields: { readonly [F in Field]: string };
  readonly slots?: { readonly [S in Slot]: readonly BlockId[] };
};

export type SlotNodes<Slot extends string> = {
  readonly [S in Slot]: readonly (BlockContent | DefinitionContent)[];
};

export type Codec<Props, Field extends string, Slot extends string = never> = {
  readonly match:
    | 'paragraph'
    | 'heading'
    | `leafDirective:${string}`
    | `containerDirective:${string}`;
  read(node: RootContent):
    | {
        readonly props: Props;
        readonly fields: { readonly [F in Field]: string };
        readonly slots?: SlotNodes<Slot>;
      }
    | undefined;
  write(block: TypedBlock<Props, Field, Slot>, slots: SlotNodes<Slot>): RootContent;
  escaped?(block: TypedBlock<Props, Field, Slot>): string;
};

export type Component<
  Name extends string,
  Props,
  Field extends string,
  Slot extends string = never,
> = {
  readonly name: Name;
  readonly props: StandardSchemaV1<unknown, Props>;
  readonly fields: readonly Field[];
  readonly labels: { readonly [F in Field]: string };
  readonly slots?: readonly Slot[];
  readonly markdown: Codec<Props, Field, Slot>;
  readonly commands?: Handlers;
  readonly transform?: (op: Op, after: DocView) => readonly Op[];
};

export type AnyComponent = Component<string, unknown, string, string>;

export type PropsOf<C extends AnyComponent> = StandardSchemaV1.InferOutput<C['props']>;

export type FieldOf<C extends AnyComponent> = C['fields'][number];

export type SlotOf<C extends AnyComponent> = NonNullable<C['slots']>[number];

export type BlockOf<P extends readonly AnyComponent[]> = {
  [I in keyof P]: TypedBlock<PropsOf<P[I]>, FieldOf<P[I]>, SlotOf<P[I]>> & {
    readonly type: P[I]['name'];
  };
}[number];

export type Directive<Props, Field extends string> = {
  readonly name: string;
  readonly props: StandardSchemaV1<unknown, Props>;
  readonly keys: readonly (keyof Props & string)[];
  readonly attributes: readonly Field[];
  readonly label?: Field;
};

export type Container<Props, Field extends string, Slot extends string> = Directive<
  Props,
  Field
> & {
  readonly slot: Slot;
};

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

export type Parent = { readonly blockId: BlockId; readonly slot: string } | null;

export type Position = {
  readonly blockId: BlockId;
  readonly field: string;
  readonly offset: number;
};

export type Presence = {
  readonly userId: string;
  readonly blockId: BlockId;
  readonly field: string;
  readonly from: number;
  readonly to: number;
};

export type Place = { readonly parent: Parent; readonly list: readonly BlockId[] };

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
    }
  | { readonly kind: 'setProps'; readonly blockId: BlockId; readonly props: Json }
  | {
      readonly kind: 'insertBlock';
      readonly block: Block;
      readonly parent: Parent;
      readonly index: number;
    }
  | { readonly kind: 'removeBlock'; readonly blockId: BlockId }
  | {
      readonly kind: 'moveBlock';
      readonly blockId: BlockId;
      readonly parent: Parent;
      readonly index: number;
    };

export type Selection =
  | {
      readonly kind: 'text';
      readonly blockId: BlockId;
      readonly field: string;
      readonly from: number;
      readonly to: number;
    }
  | { readonly kind: 'blocks'; readonly ids: readonly BlockId[] };

export type TextSelection = Extract<Selection, { readonly kind: 'text' }>;

export type NoArgs = { readonly [key: string]: never };

export type Bare = {
  readonly [C in keyof Commands]: Commands[C] extends NoArgs ? C : never;
}[keyof Commands];

export type Commands = {
  readonly insertText: { readonly text: string };
  readonly insertBreak: NoArgs;
  readonly deleteBackward: NoArgs;
  readonly deleteForward: NoArgs;
  readonly deleteSelection: NoArgs;
  readonly undo: NoArgs;
  readonly redo: NoArgs;
};

export type Result = { readonly ops: readonly Op[]; readonly selection?: Selection } | undefined;

export type Context = {
  readonly doc: DocView;
  readonly selection: Selection;
  newId(): BlockId;
};

export type Handler<Args> = (context: Context, args: Args, next: () => Result) => Result;

export type Handlers = { readonly [C in keyof Commands]?: Handler<Commands[C]> };

export type DefaultHandlers = { readonly [C in keyof Commands]: Handler<Commands[C]> };

export type Change = {
  readonly put: readonly Block[];
  readonly ids?: readonly BlockId[];
  readonly drop: readonly BlockId[];
};

export type Planned = { readonly op: Op; readonly change: Change; readonly inverse: Op };

export type Entry = {
  readonly ops: readonly Op[];
  readonly inverses: readonly Op[];
  readonly before: Selection;
  readonly after: Selection;
};

export type Step = Entry & { readonly started: number; readonly at: number };

export type History = {
  readonly done: readonly Step[];
  readonly undone: readonly Step[];
  readonly sealed: boolean;
};

export type Travel = {
  readonly history: History;
  readonly ops: readonly Op[];
  readonly inverses: readonly Op[];
  readonly selection: Selection;
};

export type Editor = {
  readonly store: Store;
  readonly ids: Atom<readonly BlockId[]>;
  readonly blocks: ReadonlyMap<BlockId, Atom<Block>>;
  readonly selection: PrimitiveAtom<Selection>;
  dispatch(...ops: Op[]): void;
  command<C extends keyof Commands>(name: C, args: Commands[C]): boolean;
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

export type Reading = BlockKind & {
  readonly fields: Fields;
  readonly slots?: { readonly [slot: string]: readonly Reading[] };
};

export type Read = Reading | null;

export type Part = {
  readonly block: Block;
  readonly gap: string;
  readonly markdown: string;
  readonly verbatim: boolean;
};

export type Verdict =
  | SaveResult
  | { readonly ok: false; readonly reason: 'unread'; readonly ids: ReadonlySet<BlockId> };
