import type { Data } from 'unified';

export type DialectFallback = 'column' | 'images' | 'depth' | 'directives' | 'cells' | 'references';

declare module 'mdast' {
  interface CodeData {
    dialectFallback?: DialectFallback;
  }
}

export type MicromarkExtension = NonNullable<Data['micromarkExtensions']>[number];
export type Construct = Exclude<
  NonNullable<NonNullable<MicromarkExtension['document']>[string]>,
  unknown[]
>;

export type State = ReturnType<Construct['tokenize']>;

export type {
  AnyComponent,
  Block,
  BlockId,
  BlockKind,
  Codec,
  CollabAdapter,
  Component,
  Container,
  Directive,
  Doc,
  DocView,
  Editor,
  EditorOptions,
  HeadingLevel,
  Json,
  Op,
  Position,
  Presence,
  RemoteOp,
  SaveResult,
  Source,
  TypedBlock,
} from './core/types.ts';
export type { EditorProps, ReactEditorOptions, ViewProps, Views } from './react/types.ts';
