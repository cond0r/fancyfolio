import { describe, expect, it } from 'vitest';
import { docOf } from '../src/core/model.ts';
import { apply } from '../src/core/ops.ts';
import type { Doc, Op } from '../src/core/types.ts';
import { docProblems, randomOp, seeded, seeds, snapshot } from './generate.ts';

const start = docOf([
  { id: 'a', type: 'heading', level: 1, text: 'Title' },
  { id: 'b', type: 'paragraph', text: 'Meet at 10:30' },
  { id: 'c', type: 'raw', text: '| x |\n| - |' },
]);

function blocks(doc: Doc) {
  return snapshot(doc);
}

describe('each op', () => {
  it('inserts text at an offset and deletes it back', () => {
    const { doc, inverse } = apply(start, { type: 'insertText', id: 'b', offset: 5, text: 'us ' });
    expect(doc.blocks.get('b')?.text).toBe('Meet us at 10:30');
    expect(inverse).toEqual({ type: 'deleteText', id: 'b', from: 5, to: 8 });
  });

  it('deletes a range and inserts it back', () => {
    const { doc, inverse } = apply(start, { type: 'deleteText', id: 'b', from: 4, to: 7 });
    expect(doc.blocks.get('b')?.text).toBe('Meet 10:30');
    expect(inverse).toEqual({ type: 'insertText', id: 'b', offset: 4, text: ' at' });
  });

  it('splits a block into a new block after it', () => {
    const op: Op = {
      type: 'splitBlock',
      id: 'a',
      offset: 2,
      newId: 'n',
      kind: { type: 'paragraph' },
    };
    const { doc, inverse } = apply(start, op);
    expect(doc.ids).toEqual(['a', 'n', 'b', 'c']);
    expect(blocks(doc).slice(0, 2)).toEqual([
      { id: 'a', type: 'heading', level: 1, text: 'Ti' },
      { id: 'n', type: 'paragraph', text: 'tle' },
    ]);
    expect(inverse).toEqual({ type: 'mergeBlocks', id: 'n' });
  });

  it('merges a block into the one before and keeps the first kind', () => {
    const { doc, inverse } = apply(start, { type: 'mergeBlocks', id: 'b' });
    expect(blocks(doc)).toEqual([
      { id: 'a', type: 'heading', level: 1, text: 'TitleMeet at 10:30' },
      start.blocks.get('c'),
    ]);
    expect(inverse).toEqual({
      type: 'splitBlock',
      id: 'a',
      offset: 5,
      newId: 'b',
      kind: { type: 'paragraph' },
    });
  });

  it('sets a block type and keeps its text and id', () => {
    const op: Op = { type: 'setType', id: 'b', kind: { type: 'heading', level: 3 } };
    const { doc, inverse } = apply(start, op);
    expect(doc.blocks.get('b')).toEqual({
      id: 'b',
      type: 'heading',
      level: 3,
      text: 'Meet at 10:30',
    });
    expect(inverse).toEqual({ type: 'setType', id: 'b', kind: { type: 'paragraph' } });
  });

  it('leaves the input doc untouched', () => {
    const before = blocks(start);
    apply(start, { type: 'mergeBlocks', id: 'b' });
    apply(start, { type: 'insertText', id: 'a', offset: 0, text: 'x' });
    expect(blocks(start)).toEqual(before);
    expect(start.ids).toEqual(['a', 'b', 'c']);
  });

  it('keeps the object of every block it does not change', () => {
    const { doc } = apply(start, { type: 'insertText', id: 'b', offset: 0, text: 'x' });
    expect(doc.blocks.get('a')).toBe(start.blocks.get('a'));
    expect(doc.blocks.get('c')).toBe(start.blocks.get('c'));
  });
  it('reads each op field once', () => {
    let reads = 0;
    const op = {
      type: 'insertText' as const,
      id: 'b',
      offset: 0,
      get text() {
        reads += 1;
        return reads === 1 ? 'x' : '<script>';
      },
    };
    const { doc, inverse } = apply(start, op);
    expect(doc.blocks.get('b')?.text).toBe('xMeet at 10:30');
    expect(inverse).toEqual({ type: 'deleteText', id: 'b', from: 0, to: 1 });
  });
});

describe('refused ops leave nothing half applied', () => {
  const refused: [string, Op][] = [
    ['an unknown block', { type: 'insertText', id: 'zz', offset: 0, text: 'x' }],
    ['an offset past the end', { type: 'insertText', id: 'b', offset: 14, text: 'x' }],
    ['a negative offset', { type: 'insertText', id: 'b', offset: -1, text: 'x' }],
    ['a fractional offset', { type: 'insertText', id: 'b', offset: 1.5, text: 'x' }],
    ['empty text', { type: 'insertText', id: 'b', offset: 0, text: '' }],
    ['a carriage return', { type: 'insertText', id: 'b', offset: 0, text: 'x\r\ny' }],
    ['a NUL character', { type: 'insertText', id: 'b', offset: 0, text: '\0' }],
    ['a lone surrogate', { type: 'insertText', id: 'b', offset: 0, text: '\ud83d' }],
    ['an empty range', { type: 'deleteText', id: 'b', from: 2, to: 2 }],
    ['a reversed range', { type: 'deleteText', id: 'b', from: 3, to: 2 }],
    ['a range past the end', { type: 'deleteText', id: 'b', from: 2, to: 14 }],
    ['a range from before the start', { type: 'deleteText', id: 'b', from: -1, to: 2 }],
    [
      'a split with a taken id',
      { type: 'splitBlock', id: 'b', offset: 1, newId: 'c', kind: { type: 'paragraph' } },
    ],
    [
      'a split with an empty id',
      { type: 'splitBlock', id: 'b', offset: 1, newId: '', kind: { type: 'paragraph' } },
    ],
    [
      'a split past the end',
      { type: 'splitBlock', id: 'b', offset: 99, newId: 'n', kind: { type: 'paragraph' } },
    ],
    ['merging the first block', { type: 'mergeBlocks', id: 'a' }],
    ['heading level 0', { type: 'setType', id: 'b', kind: { type: 'heading', level: 0 as 1 } }],
    ['heading level 7', { type: 'setType', id: 'b', kind: { type: 'heading', level: 7 as 1 } }],
    ['heading level 1.5', { type: 'setType', id: 'b', kind: { type: 'heading', level: 1.5 as 1 } }],
    ['an unknown block type', { type: 'setType', id: 'b', kind: { type: 'table' } as never }],
    [
      'a split into an unknown type',
      { type: 'splitBlock', id: 'b', offset: 1, newId: 'n', kind: { type: 'list' } as never },
    ],
  ];

  it.each(refused)('refuses %s', (_name, op) => {
    const before = blocks(start);
    expect(() => apply(start, op)).toThrow(RangeError);
    expect(blocks(start)).toEqual(before);
  });

  it.each([
    [
      'setting the kind a block already has',
      { type: 'setType', id: 'b', kind: { type: 'paragraph' } },
    ],
    [
      'setting the level a heading already has',
      { type: 'setType', id: 'a', kind: { type: 'heading', level: 1 } },
    ],
    [
      'turning raw source into plain text',
      { type: 'setType', id: 'c', kind: { type: 'paragraph' } },
    ],
    ['turning plain text into raw source', { type: 'setType', id: 'b', kind: { type: 'raw' } }],
    ['merging plain text into raw source', { type: 'mergeBlocks', id: 'd' }],
    ['merging raw source into plain text', { type: 'mergeBlocks', id: 'c' }],
    [
      'splitting raw source into plain text',
      { type: 'splitBlock', id: 'c', offset: 5, newId: 'n', kind: { type: 'paragraph' } },
    ],
    [
      'splitting plain text into raw source',
      { type: 'splitBlock', id: 'b', offset: 4, newId: 'n', kind: { type: 'raw' } },
    ],
  ] satisfies [string, Op][])('refuses %s', (_name, op) => {
    const doc = docOf([...blocks(start), { id: 'd', type: 'paragraph', text: '<b onclick=x>' }]);
    const before = blocks(doc);
    expect(() => apply(doc, op)).toThrow(RangeError);
    expect(blocks(doc)).toEqual(before);
  });

  it('moves no text between raw source and plain text, so an empty block may cross', () => {
    const doc = docOf([...blocks(start), { id: 'd', type: 'paragraph', text: '' }]);
    const split = apply(doc, {
      type: 'splitBlock',
      id: 'c',
      offset: 11,
      newId: 'n',
      kind: { type: 'paragraph' },
    });
    expect(split.doc.blocks.get('n')).toEqual({ id: 'n', type: 'paragraph', text: '' });
    expect(apply(split.doc, split.inverse).doc.ids).toEqual(doc.ids);
    const merged = apply(doc, { type: 'mergeBlocks', id: 'd' });
    expect(blocks(merged.doc).at(-1)).toEqual(start.blocks.get('c'));
    const raw = apply(doc, { type: 'setType', id: 'd', kind: { type: 'raw' } });
    expect(raw.doc.blocks.get('d')).toEqual({ id: 'd', type: 'raw', text: '' });
  });

  it.each([
    ['text as a number', '{"type":"insertText","id":"b","offset":0,"text":123}'],
    ['text as an array', '{"type":"insertText","id":"b","offset":0,"text":["<script>"]}'],
    ['text as an object', '{"type":"insertText","id":"b","offset":0,"text":{"length":0}}'],
    ['a missing text', '{"type":"insertText","id":"b","offset":0}'],
    ['offsets as strings', '{"type":"deleteText","id":"b","from":"0","to":"1"}'],
    [
      'a null new id',
      '{"type":"splitBlock","id":"b","offset":0,"newId":null,"kind":{"type":"paragraph"}}',
    ],
    [
      'a number new id',
      '{"type":"splitBlock","id":"b","offset":0,"newId":7,"kind":{"type":"paragraph"}}',
    ],
    [
      'an object new id',
      '{"type":"splitBlock","id":"b","offset":0,"newId":{"a":1},"kind":{"type":"paragraph"}}',
    ],
    ['a null kind', '{"type":"setType","id":"b","kind":null}'],
    ['a string level', '{"type":"setType","id":"b","kind":{"type":"heading","level":"1"}}'],
    ['a number id', '{"type":"mergeBlocks","id":7}'],
    ['an unknown op', '{"type":"evil","id":"b"}'],
    ['no op at all', 'null'],
  ])('refuses an op with %s', (_name, json) => {
    const before = blocks(start);
    expect(() => apply(start, JSON.parse(json))).toThrow(RangeError);
    expect(blocks(start)).toEqual(before);
  });

  it('refuses to join or cut raw source, so a fence never runs into the next block', () => {
    const doc = docOf([
      { id: 'r', type: 'raw', text: '```js\nx\n```' },
      { id: 's', type: 'raw', text: '- item' },
      { id: 'e', type: 'raw', text: '' },
    ]);
    const before = blocks(doc);
    expect(() => apply(doc, { type: 'mergeBlocks', id: 's' })).toThrow(RangeError);
    expect(() =>
      apply(doc, { type: 'splitBlock', id: 'r', offset: 5, newId: 'n', kind: { type: 'raw' } }),
    ).toThrow(RangeError);
    expect(blocks(doc)).toEqual(before);
    expect(apply(doc, { type: 'mergeBlocks', id: 'e' }).doc.ids).toEqual(['r', 's']);
    const cut = apply(doc, {
      type: 'splitBlock',
      id: 's',
      offset: 6,
      newId: 'n',
      kind: { type: 'raw' },
    });
    expect(blocks(apply(cut.doc, cut.inverse).doc)).toEqual(before);
  });

  it('refuses a cut inside a surrogate pair', () => {
    const emoji = docOf([{ id: 'e', type: 'paragraph', text: 'a😀b' }]);
    expect(() => apply(emoji, { type: 'deleteText', id: 'e', from: 1, to: 2 })).toThrow(RangeError);
    expect(() => apply(emoji, { type: 'insertText', id: 'e', offset: 2, text: 'x' })).toThrow(
      RangeError,
    );
    expect(() =>
      apply(emoji, { type: 'splitBlock', id: 'e', offset: 2, newId: 'n', kind: { type: 'raw' } }),
    ).toThrow(RangeError);
  });
});

describe('random op sequences', () => {
  it.each(seeds)('keep every invariant and invert exactly (seed %i)', (seed) => {
    const random = seeded(seed);
    let next = 0;
    let doc = start;
    for (let step = 0; step < 300; step += 1) {
      const op = randomOp(doc, random, () => `n${next++}`);
      const where = `seed ${seed} step ${step} ${JSON.stringify(op)}`;
      const { doc: after, inverse } = apply(doc, op);
      expect(docProblems(after), where).toEqual([]);
      const back = apply(after, inverse).doc;
      expect(back.ids, where).toEqual(doc.ids);
      expect(blocks(back), where).toEqual(blocks(doc));
      const removed = doc.ids.filter((id) => !after.blocks.has(id));
      const added = after.ids.filter((id) => !doc.blocks.has(id));
      expect(removed, where).toEqual(op.type === 'mergeBlocks' ? [op.id] : []);
      expect(added, where).toEqual(op.type === 'splitBlock' ? [op.newId] : []);
      for (const id of after.ids) {
        if (id !== op.id && !added.includes(id) && op.type !== 'mergeBlocks') {
          expect(after.blocks.get(id), where).toBe(doc.blocks.get(id));
        }
      }
      doc = after;
    }
  });
});
