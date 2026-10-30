import * as editor from '@fancyfolio/editor';
import type {
  Block,
  BlockId,
  BlockKind,
  DialectFallback,
  Doc,
  Editor,
  EditorOptions,
  HeadingLevel,
  Op,
  SaveResult,
  Source,
} from '@fancyfolio/editor/types';
import { describe, expect, it } from 'vitest';
import { counter } from './generate.ts';

describe('the package root', () => {
  it('exports the editor core and nothing else at run time', () => {
    expect(Object.keys(editor).sort()).toEqual(['apply', 'createEditor', 'load', 'save']);
    const { apply, createEditor, load, save } = editor;
    const body = '# Title\n\nMeet at 10:30, Status:done\n';
    expect(createEditor(body, { now: () => 0, newId: counter() }).markdown()).toEqual({
      ok: true,
      markdown: body,
    });
    const doc = load('a\n', counter());
    const [id = ''] = doc.ids;
    const op = { kind: 'insertText', blockId: id, field: 'text', offset: 1, text: 'b' } as const;
    expect(save(apply(doc, op).doc)).toEqual({
      ok: true,
      markdown: 'ab\n',
    });
  });

  it('exports the public types from ./types and no value', async () => {
    expect(Object.keys(await import('@fancyfolio/editor/types'))).toEqual([]);
    const exported: [
      Block?,
      BlockId?,
      BlockKind?,
      DialectFallback?,
      Doc?,
      Editor?,
      EditorOptions?,
      HeadingLevel?,
      Op?,
      SaveResult?,
      Source?,
    ] = [];
    expect(exported).toEqual([]);
  });
});
