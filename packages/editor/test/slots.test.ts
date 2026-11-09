import { describe, expect, it } from 'vitest';
import { containerDirective, leafDirective } from '../src/core/directive.ts';
import { hasKeys, noProps, schema } from '../src/core/model.ts';
import { createEditor } from '../src/core/store.ts';
import type { AnyComponent, Block, Component, Editor, NoProps, Op } from '../src/core/types.ts';
import { counter } from './generate.ts';

const toneProps = schema(
  (value): value is { readonly tone: string } =>
    hasKeys(value, ['tone']) && typeof Reflect.get(value, 'tone') === 'string',
);

const callout: Component<'callout', { readonly tone: string }, never, 'body'> = {
  name: 'callout',
  props: toneProps,
  fields: [],
  slots: ['body'],
  markdown: containerDirective({
    name: 'callout',
    props: toneProps,
    keys: ['tone'],
    attributes: [],
    slot: 'body',
  }),
};

const metric: Component<'metric', NoProps, 'value'> = {
  name: 'metric',
  props: noProps,
  fields: ['value'],
  markdown: leafDirective({ name: 'metric', props: noProps, keys: [], attributes: ['value'] }),
};

const page = 'Before.\n\n:::callout{tone="info"}\nFirst\n\nSecond\n:::\n\nAfter.\n';

function editorAt(markdown = page): Editor {
  return createEditor(markdown, { now: () => 0, newId: counter(), components: [callout, metric] });
}

function tree(editor: Editor) {
  const doc = editor.doc();
  const of = (id: string): unknown => {
    const { slots, ...rest } = doc.blocks.get(id) as Block;
    return slots === undefined
      ? [rest.id, rest.fields.text ?? rest.type]
      : [rest.id, rest.type, Object.values(slots).map((ids) => ids.map(of))];
  };
  return doc.ids.map(of);
}

function saved(editor: Editor): string {
  const result = editor.markdown();
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.markdown;
}

const loadedTree = [
  ['b0', 'Before.'],
  [
    'b1',
    'callout',
    [
      [
        ['b2', 'First'],
        ['b3', 'Second'],
      ],
    ],
  ],
  ['b4', 'After.'],
];

const paragraph = (id: string, text = ''): Block => ({
  id,
  type: 'paragraph',
  props: {},
  fields: { text },
});

const split = (blockId: string, offset: number, newId: string, type = 'paragraph'): Op => ({
  kind: 'splitBlock',
  blockId,
  field: 'text',
  offset,
  newId,
  type,
  props: type === 'callout' ? { tone: 'info' } : {},
});

describe('blocks in a slot', () => {
  it.each([
    [
      'a split',
      [split('b2', 2, 'n')],
      [
        ['b2', 'Fi'],
        ['n', 'rst'],
        ['b3', 'Second'],
      ],
    ],
    ['a merge', [{ kind: 'mergeBlocks', blockId: 'b3' }], [['b2', 'FirstSecond']]],
    [
      'an insert',
      [
        {
          kind: 'insertBlock',
          block: paragraph('n', 'New'),
          parent: { blockId: 'b1', slot: 'body' },
          index: 2,
        },
      ],
      [
        ['b2', 'First'],
        ['b3', 'Second'],
        ['n', 'New'],
      ],
    ],
    ['a removal', [{ kind: 'removeBlock', blockId: 'b2' }], [['b3', 'Second']]],
  ] satisfies [string, Op[], unknown[]][])(
    'keeps %s inside its slot and undoes it',
    (_name, ops, body) => {
      const editor = editorAt();
      editor.dispatch(...ops);
      expect(tree(editor)).toEqual([loadedTree[0], ['b1', 'callout', [body]], loadedTree[2]]);
      expect(editor.undo()).toBe(true);
      expect(tree(editor)).toEqual(loadedTree);
      expect(saved(editor)).toBe(page);
      expect(editor.redo()).toBe(true);
      expect(tree(editor)).toEqual([loadedTree[0], ['b1', 'callout', [body]], loadedTree[2]]);
    },
  );

  it('saves an edit inside a slot so that it reloads to the same blocks', () => {
    const editor = editorAt();
    editor.dispatch(split('b3', 3, 'n'), {
      kind: 'insertText',
      blockId: 'n',
      field: 'text',
      offset: 0,
      text: '- ',
    });
    const reloaded = editorAt(saved(editor));
    const texts = (each: Editor) => JSON.stringify(tree(each)).replace(/"b\d+"|"n"/g, '');
    expect(texts(reloaded)).toBe(texts(editor));
  });

  const callBlock = (id: string): Block => ({
    id,
    type: 'callout',
    props: { tone: 'info' },
    fields: {},
    slots: { body: [] },
  });

  it.each([
    [
      'a merge into the block before the slot',
      { kind: 'mergeBlocks', blockId: 'b2' },
      'no block before',
    ],
    ['a merge of a container', { kind: 'mergeBlocks', blockId: 'b1' }, 'the block has slots'],
    ['a merge into a container', { kind: 'mergeBlocks', blockId: 'b4' }, 'the block has slots'],
    ['a split into a container', split('b2', 0, 'n', 'callout'), 'the block has slots'],
    [
      'a slot child with slots',
      {
        kind: 'insertBlock',
        block: callBlock('n'),
        parent: { blockId: 'b1', slot: 'body' },
        index: 0,
      },
      'a slot child has no slots',
    ],
    [
      'a slot child turned into a container',
      { kind: 'setType', blockId: 'b2', type: 'callout', props: { tone: 'info' } },
      'a slot child has no slots',
    ],
    [
      'raw source in a slot',
      { kind: 'setType', blockId: 'b2', type: 'raw', props: {} },
      'raw source stays at the top level',
    ],
    [
      'an unknown slot',
      {
        kind: 'insertBlock',
        block: paragraph('n'),
        parent: { blockId: 'b1', slot: 'aside' },
        index: 0,
      },
      'unknown slot',
    ],
    [
      'a slot on a block without slots',
      {
        kind: 'insertBlock',
        block: paragraph('n'),
        parent: { blockId: 'b0', slot: 'body' },
        index: 0,
      },
      'unknown slot',
    ],
    [
      'an index outside the slot',
      {
        kind: 'insertBlock',
        block: paragraph('n'),
        parent: { blockId: 'b1', slot: 'body' },
        index: 3,
      },
      'index outside the list',
    ],
    [
      'a container inserted with children',
      {
        kind: 'insertBlock',
        block: { ...callBlock('n'), slots: { body: ['b0'] } },
        parent: null,
        index: 0,
      },
      'slots start empty',
    ],
    [
      'slots on a block without slots',
      { kind: 'insertBlock', block: { ...paragraph('n'), slots: {} }, parent: null, index: 0 },
      'slots start empty',
    ],
    [
      'the removal of a container with children',
      { kind: 'removeBlock', blockId: 'b1' },
      'a container with children stays',
    ],
    [
      'a container turned into a block without its slot',
      { kind: 'setType', blockId: 'b1', type: 'paragraph', props: {} },
      'the new type has no slot for its blocks',
    ],
  ] satisfies [string, Op, string][])('refuses %s', (_name, op, reason) => {
    const editor = editorAt();
    expect(() => editor.dispatch(op)).toThrow(new RangeError(`${op.kind} refused: ${reason}`));
    expect(tree(editor)).toEqual(loadedTree);
  });

  it('turns a top-level block into an empty container and back', () => {
    const editor = editorAt('');
    editor.dispatch({ kind: 'setType', blockId: 'b0', type: 'callout', props: { tone: 'info' } });
    expect(editor.doc().blocks.get('b0')).toEqual(callBlock('b0'));
    editor.dispatch({
      kind: 'insertBlock',
      block: paragraph('n', 'Inside'),
      parent: { blockId: 'b0', slot: 'body' },
      index: 0,
    });
    expect(saved(editor)).toBe(':::callout{tone="info"}\nInside\n:::\n');
    editor.undo();
    editor.undo();
    expect(editor.doc().blocks.get('b0')).toEqual(paragraph('b0'));
  });

  it('removes a container once its slot is empty, and undo brings it back', () => {
    const editor = editorAt();
    editor.dispatch(
      { kind: 'removeBlock', blockId: 'b2' },
      { kind: 'removeBlock', blockId: 'b3' },
      { kind: 'removeBlock', blockId: 'b1' },
    );
    expect(tree(editor)).toEqual([loadedTree[0], loadedTree[2]]);
    expect(editor.doc().blocks.size).toBe(2);
    editor.undo();
    expect(tree(editor)).toEqual(loadedTree);
    expect(saved(editor)).toBe(page);
  });
});

describe('transforms', () => {
  function withTransform(transform: AnyComponent['transform']): Editor {
    const host: AnyComponent = {
      ...metric,
      name: 'host',
      markdown: { ...metric.markdown, match: 'leafDirective:host' },
      transform,
    };
    return createEditor(page, {
      now: () => 0,
      newId: counter(),
      components: [callout, metric, host],
    });
  }

  const refill: AnyComponent['transform'] = (op, after) => {
    const body = after.blocks.get('b1')?.slots?.body;
    if (op.kind !== 'removeBlock' || body === undefined || body.length > 0) return [];
    return [
      {
        kind: 'insertBlock',
        block: paragraph('filled'),
        parent: { blockId: 'b1', slot: 'body' },
        index: 0,
      },
    ];
  };

  it('lands a follow-up in the same undo step as the op that caused it', () => {
    const editor = withTransform(refill);
    editor.dispatch({ kind: 'removeBlock', blockId: 'b2' }, { kind: 'removeBlock', blockId: 'b3' });
    expect(tree(editor)).toEqual([
      loadedTree[0],
      ['b1', 'callout', [[['filled', '']]]],
      loadedTree[2],
    ]);
    expect(editor.undo()).toBe(true);
    expect(tree(editor)).toEqual(loadedTree);
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(true);
    expect(tree(editor)).toEqual([
      loadedTree[0],
      ['b1', 'callout', [[['filled', '']]]],
      loadedTree[2],
    ]);
  });

  it.each<[string, NonNullable<AnyComponent['transform']>]>([
    ['a follow-up that refuses', () => [{ kind: 'removeBlock', blockId: 'missing' }]],
    [
      'a transform that throws',
      () => {
        throw new Error('transform bug');
      },
    ],
  ])('refuses the whole dispatch on %s', (_name, transform) => {
    const editor = withTransform((op, after) =>
      'blockId' in op && op.blockId === 'b4' ? transform(op, after) : [],
    );
    editor.dispatch({
      kind: 'insertText',
      blockId: 'b0',
      field: 'text',
      offset: 0,
      text: 'kept ',
    });
    expect(() =>
      editor.dispatch({ kind: 'insertText', blockId: 'b4', field: 'text', offset: 0, text: 'x' }),
    ).toThrow();
    expect(tree(editor)).toEqual([['b0', 'kept Before.'], loadedTree[1], loadedTree[2]]);
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe(page);
  });

  it('runs once per op and component, on the doc after the op, never on follow-ups or undo', () => {
    const seen: string[] = [];
    const editor = withTransform((op, after) => {
      if (op.kind !== 'insertText') return [];
      seen.push(after.blocks.get(op.blockId)?.fields.text ?? '');
      return [{ ...op, offset: op.offset + op.text.length, text: '!' }];
    });
    editor.dispatch(
      { kind: 'insertText', blockId: 'b0', field: 'text', offset: 0, text: 'a' },
      { kind: 'insertText', blockId: 'b2', field: 'text', offset: 5, text: 'b' },
    );
    expect(seen).toEqual(['aBefore.', 'Firstb']);
    expect(tree(editor)[0]).toEqual(['b0', 'a!Before.']);
    expect(editor.doc().blocks.get('b2')?.fields.text).toBe('Firstb!');
    editor.undo();
    editor.redo();
    expect(seen).toHaveLength(2);
  });
});
