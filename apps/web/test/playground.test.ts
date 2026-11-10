import { createEditor } from '@fancyfolio/editor';
import { createReactEditor } from '@fancyfolio/editor/react';
import type { Editor } from '@fancyfolio/editor/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { callout, components, metric } from '../app/(app)/playground/components.ts';
import { body } from '../app/(app)/playground/fixture.ts';
import { Callout } from '../components/blocks/callout.tsx';
import { Metric } from '../components/blocks/metric.tsx';

const paragraph = (id: string, text = '') => ({
  id,
  type: 'paragraph',
  props: {},
  fields: { text },
});

function docOf(body: readonly string[], texts: { readonly [id: string]: string } = {}) {
  const box = { id: 'c', type: 'callout', props: { tone: 'info' }, fields: {}, slots: { body } };
  const children = body.map((id) => paragraph(id, texts[id]));
  const blocks = new Map([paragraph('p', 'Before.'), box, ...children].map((b) => [b.id, b]));
  return { ids: ['p', 'c'], blocks };
}

function caret(blockId: string, field = 'text', offset = 0) {
  return { kind: 'text', blockId, field, from: offset, to: offset } as const;
}

const lower = () => ({ ops: [{ kind: 'removeBlock', blockId: 'lower' }] as const });

describe('the metric component', () => {
  const block = { id: 'm', type: 'metric', props: {}, fields: { value: '42%', label: 'Faster' } };
  const doc = { ids: ['m', 'p'], blocks: new Map([block, paragraph('p')].map((b) => [b.id, b])) };
  const breakIn = (selection: ReturnType<typeof caret>) =>
    metric.commands?.insertBreak?.({ doc, selection, newId: () => 'n' }, {}, lower);

  it('claims Enter in either field and adds nothing', () => {
    expect(breakIn(caret('m', 'value', 1))).toEqual({ ops: [] });
    expect(breakIn(caret('m', 'label', 6))).toEqual({ ops: [] });
  });

  it('leaves Enter in any other block to the lower handlers', () => {
    expect(breakIn(caret('p'))).toBeUndefined();
  });
});

describe('the callout component', () => {
  const breakAt = (doc: ReturnType<typeof docOf>, blockId: string) =>
    callout.commands?.insertBreak?.(
      { doc, selection: caret(blockId), newId: () => 'n' },
      {},
      lower,
    );

  it('moves Enter in an empty last child out of the callout, after it', () => {
    expect(breakAt(docOf(['a', 'b'], { a: 'Kept' }), 'b')).toEqual({
      ops: [
        { kind: 'removeBlock', blockId: 'b' },
        { kind: 'insertBlock', block: paragraph('n'), parent: null, index: 2 },
      ],
      selection: caret('n'),
    });
  });

  it.each([
    ['a child that is not the last', docOf(['a', 'b']), 'a'],
    ['a last child with text', docOf(['a', 'b'], { b: 'Text' }), 'b'],
    ['a block outside the callout', docOf(['a']), 'p'],
  ])('leaves Enter in %s to the lower handlers', (_name, doc, blockId) => {
    expect(breakAt(doc, blockId)).toBeUndefined();
  });

  it('refills a slot that a removal empties with one empty paragraph', () => {
    const [follow, ...rest] =
      callout.transform?.({ kind: 'removeBlock', blockId: 'a' }, docOf([])) ?? [];
    expect(rest).toEqual([]);
    expect(follow).toEqual({
      kind: 'insertBlock',
      block: paragraph(follow?.kind === 'insertBlock' ? follow.block.id : ''),
      parent: { blockId: 'c', slot: 'body' },
      index: 0,
    });
    expect(follow?.kind === 'insertBlock' && follow.block.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['a removal that leaves a child', { kind: 'removeBlock', blockId: 'b' } as const, docOf(['a'])],
    ['an op that is no removal', { kind: 'mergeBlocks', blockId: 'b' } as const, docOf([])],
  ])('adds nothing after %s', (_name, op, after) => {
    expect(callout.transform?.(op, after)).toEqual([]);
  });
});

describe('the playground editor', () => {
  it('exposes every field as a textbox named by its component label', () => {
    const Editor = createReactEditor({ components, views: { callout: Callout, metric: Metric } });
    const markup = renderToStaticMarkup(createElement(Editor, { markdown: body }));
    const fields = [...markup.matchAll(/<span[^>]*data-field[^>]*>/g)].map(([tag]) => tag);
    expect(fields.map((tag) => /aria-label="([^"]*)"/.exec(tag)?.[1])).toEqual([
      'Heading',
      'Paragraph',
      'Paragraph',
      'Heading',
      'Paragraph',
      'Metric value',
      'Metric label',
      'Paragraph',
    ]);
    expect(fields.every((tag) => tag.includes('role="textbox"'))).toBe(true);
  });
});

describe('the playground fixture', () => {
  const quoted = '" onmouseover="alert(1)';
  const scripted = 'javascript:alert(1)';

  function editorOf(markdown: string): Editor {
    let count = 0;
    return createEditor(markdown, { now: () => 0, newId: () => `b${count++}`, components });
  }

  function saved(editor: Editor): string {
    const result = editor.markdown();
    if (!result.ok) throw new Error(`save refused: ${result.reason}`);
    return result.markdown;
  }

  const shape = (editor: Editor) => {
    const { ids, blocks } = editor.doc();
    return { ids, blocks };
  };

  it('saves untouched byte-identically', () => {
    expect(saved(editorOf(body))).toBe(body);
  });

  it('reloads an emptied callout with its one empty paragraph and saves it unchanged', () => {
    const editor = editorOf(body);
    const { ids, blocks } = editor.doc();
    const [child = ''] = blocks.get(ids.at(-1) ?? '')?.slots?.body ?? [];
    const text = blocks.get(child)?.fields.text ?? '';
    editor.dispatch({
      kind: 'deleteText',
      blockId: child,
      field: 'text',
      from: 0,
      to: text.length,
    });
    const markdown = saved(editor);
    expect(markdown).toBe(body.replace(`${text}\n`, ''));
    const reloaded = editorOf(markdown);
    expect(shape(reloaded)).toEqual(shape(editor));
    expect(saved(reloaded)).toBe(markdown);
  });

  it('saves metric payloads typed in place as attributes and reloads them equal', () => {
    const editor = editorOf(body);
    const { ids, blocks } = editor.doc();
    const blockId = ids.find((id) => blocks.get(id)?.type === 'metric') ?? '';
    editor.dispatch(
      { kind: 'insertText', blockId, field: 'value', offset: 7, text: quoted },
      { kind: 'insertText', blockId, field: 'label', offset: 15, text: scripted },
    );
    const markdown = saved(editor);
    const reloaded = editorOf(markdown);
    expect(shape(reloaded)).toEqual(shape(editor));
    const fields = reloaded.doc().blocks.get(blockId)?.fields;
    expect(fields).toEqual({ value: `3 steps${quoted}`, label: `Checkout length${scripted}` });
    expect(markdown.split('\n').filter((line) => line.startsWith('::metric'))).toEqual([
      '::metric{value="3 steps&#x22; onmouseover=&#x22;alert(1)" label="Checkout lengthjavascript:alert(1)"}',
    ]);
    const markup = renderToStaticMarkup(
      createElement(Metric, { fields: { value: fields?.value, label: fields?.label } }),
    );
    expect(markup).not.toMatch(/<[^>]*(onmouseover|href|src)=/);
    expect(markup).toContain('&quot; onmouseover=&quot;alert(1)');
  });
});
