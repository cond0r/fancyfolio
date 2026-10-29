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
  Block,
  BlockId,
  BlockKind,
  Doc,
  Editor,
  EditorOptions,
  HeadingLevel,
  Op,
  SaveResult,
  Source,
} from './core/types.ts';
