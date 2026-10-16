export { load, type SaveResult, save } from './core/markdown.ts';
export type { Block, BlockId, BlockKind, Doc, HeadingLevel, Source } from './core/model.ts';
export { apply, type Op } from './core/ops.ts';
export { createEditor, type Editor, type EditorOptions } from './core/store.ts';
