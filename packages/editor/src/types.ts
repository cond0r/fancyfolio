import type { Parent, PhrasingContent } from 'mdast';
import type { Data } from 'unified';

export type DialectFallback = 'column' | 'images' | 'depth' | 'directives' | 'cells' | 'references';

declare module 'mdast' {
  interface CodeData {
    dialectFallback?: DialectFallback;
  }

  interface Highlight extends Parent {
    type: 'highlight';
    children: PhrasingContent[];
  }

  interface PhrasingContentMap {
    highlight: Highlight;
  }

  interface RootContentMap {
    highlight: Highlight;
  }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    highlight: 'highlight';
    highlightSequence: 'highlightSequence';
    highlightSequenceTemporary: 'highlightSequenceTemporary';
    highlightText: 'highlightText';
  }
}

export type ToMarkdownExtension = NonNullable<Data['toMarkdownExtensions']>[number];
export type Handle = NonNullable<NonNullable<ToMarkdownExtension['handlers']>['highlight']>;
export type Unsafe = NonNullable<ToMarkdownExtension['unsafe']>[number];

export type { Code, Event, Resolver, Token, TokenizeContext } from 'micromark-util-types';

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
  Color,
  Component,
  Container,
  Directive,
  Doc,
  DocView,
  Editor,
  EditorOptions,
  HeadingLevel,
  Json,
  Mark,
  Marks,
  MarkType,
  OnSave,
  Op,
  Position,
  Presence,
  RemoteOp,
  SafeHref,
  SaveOutcome,
  SaveResult,
  SaveState,
  Source,
  Span,
  Stored,
  TypedBlock,
  Version,
} from './core/types.ts';
export type {
  BlockChrome,
  EditorProps,
  ReactEditorOptions,
  ViewProps,
  Views,
} from './react/types.ts';
