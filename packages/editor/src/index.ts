export { load, save } from './core/markdown.ts';
export { apply } from './core/ops.ts';
export { createEditor } from './core/store.ts';
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
