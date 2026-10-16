import * as editor from '@fancyfolio/editor';
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
    expect(save(apply(doc, { type: 'insertText', id, offset: 1, text: 'b' }).doc)).toEqual({
      ok: true,
      markdown: 'ab\n',
    });
  });
});
