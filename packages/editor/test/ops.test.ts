import { describe, expect, it } from 'vitest';
import { docOf } from '../src/core/model.ts';
import { apply } from '../src/core/ops.ts';
import { registryOf } from '../src/core/registry.ts';
import type { AnyComponent, Doc, Op } from '../src/core/types.ts';
import { docProblems, randomOp, seeded, seeds, snapshot } from './generate.ts';

const start = docOf([
  { id: 'a', type: 'heading', props: { level: 1 }, fields: { text: 'Title' } },
  { id: 'b', type: 'paragraph', props: {}, fields: { text: 'Meet at 10:30' } },
  { id: 'c', type: 'raw', props: {}, fields: { text: '| x |\n| - |' } },
]);

function blocks(doc: Doc) {
  return snapshot(doc);
}

const paragraph = { type: 'paragraph', props: {} } as const;

describe('each op', () => {
  it('inserts text at an offset and deletes it back', () => {
    const { doc, inverse } = apply(start, {
      kind: 'insertText',
      blockId: 'b',
      field: 'text',
      offset: 5,
      text: 'us ',
    });
    expect(doc.blocks.get('b')?.fields.text).toBe('Meet us at 10:30');
    expect(inverse).toEqual({ kind: 'deleteText', blockId: 'b', field: 'text', from: 5, to: 8 });
  });

  it('deletes a range and inserts it back', () => {
    const { doc, inverse } = apply(start, {
      kind: 'deleteText',
      blockId: 'b',
      field: 'text',
      from: 4,
      to: 7,
    });
    expect(doc.blocks.get('b')?.fields.text).toBe('Meet 10:30');
    expect(inverse).toEqual({
      kind: 'insertText',
      blockId: 'b',
      field: 'text',
      offset: 4,
      text: ' at',
    });
  });

  it('splits a block into a new block after it', () => {
    const op: Op = {
      kind: 'splitBlock',
      blockId: 'a',
      field: 'text',
      offset: 2,
      newId: 'n',
      ...paragraph,
    };
    const { doc, inverse } = apply(start, op);
    expect(doc.ids).toEqual(['a', 'n', 'b', 'c']);
    expect(blocks(doc).slice(0, 2)).toEqual([
      { id: 'a', type: 'heading', props: { level: 1 }, fields: { text: 'Ti' } },
      { id: 'n', type: 'paragraph', props: {}, fields: { text: 'tle' } },
    ]);
    expect(inverse).toEqual({ kind: 'mergeBlocks', blockId: 'n' });
  });

  it('merges a block into the one before and keeps the first kind', () => {
    const { doc, inverse } = apply(start, { kind: 'mergeBlocks', blockId: 'b' });
    expect(blocks(doc)).toEqual([
      { id: 'a', type: 'heading', props: { level: 1 }, fields: { text: 'TitleMeet at 10:30' } },
      start.blocks.get('c'),
    ]);
    expect(inverse).toEqual({
      kind: 'splitBlock',
      blockId: 'a',
      field: 'text',
      offset: 5,
      newId: 'b',
      ...paragraph,
    });
  });

  it('sets a block type and keeps its text and id', () => {
    const op: Op = { kind: 'setType', blockId: 'b', type: 'heading', props: { level: 3 } };
    const { doc, inverse } = apply(start, op);
    expect(doc.blocks.get('b')).toEqual({
      id: 'b',
      type: 'heading',
      props: { level: 3 },
      fields: { text: 'Meet at 10:30' },
    });
    expect(inverse).toEqual({ kind: 'setType', blockId: 'b', ...paragraph });
  });

  it('leaves the input doc untouched', () => {
    const before = blocks(start);
    apply(start, { kind: 'mergeBlocks', blockId: 'b' });
    apply(start, { kind: 'insertText', blockId: 'a', field: 'text', offset: 0, text: 'x' });
    expect(blocks(start)).toEqual(before);
    expect(start.ids).toEqual(['a', 'b', 'c']);
  });

  it('keeps the object of every block it does not change', () => {
    const { doc } = apply(start, {
      kind: 'insertText',
      blockId: 'b',
      field: 'text',
      offset: 0,
      text: 'x',
    });
    expect(doc.blocks.get('a')).toBe(start.blocks.get('a'));
    expect(doc.blocks.get('c')).toBe(start.blocks.get('c'));
  });
  it('reads each op field once', () => {
    let reads = 0;
    const op = {
      kind: 'insertText' as const,
      blockId: 'b',
      field: 'text',
      offset: 0,
      get text() {
        reads += 1;
        return reads === 1 ? 'x' : '<script>';
      },
    };
    const { doc, inverse } = apply(start, op);
    expect(doc.blocks.get('b')?.fields.text).toBe('xMeet at 10:30');
    expect(inverse).toEqual({ kind: 'deleteText', blockId: 'b', field: 'text', from: 0, to: 1 });
  });
});

describe('refused ops leave nothing half applied', () => {
  const insert = (text: string, offset = 0, field = 'text'): Op => ({
    kind: 'insertText',
    blockId: 'b',
    field,
    offset,
    text,
  });
  const range = (from: number, to: number): Op => ({
    kind: 'deleteText',
    blockId: 'b',
    field: 'text',
    from,
    to,
  });
  const split = (newId: string, offset: number, kind: object = paragraph, field = 'text'): Op =>
    ({ kind: 'splitBlock', blockId: 'b', field, offset, newId, ...kind }) as Op;
  const heading = (level: number) => ({ type: 'heading', props: { level } });
  const refused: [string, Op][] = [
    [
      'an unknown block',
      { kind: 'insertText', blockId: 'zz', field: 'text', offset: 0, text: 'x' },
    ],
    ['an offset past the end', insert('x', 14)],
    ['a negative offset', insert('x', -1)],
    ['a fractional offset', insert('x', 1.5)],
    ['empty text', insert('')],
    ['a carriage return', insert('x\r\ny')],
    ['a NUL character', insert('\0')],
    ['a lone surrogate', insert('\ud83d')],
    ['an empty range', range(2, 2)],
    ['a reversed range', range(3, 2)],
    ['a range past the end', range(2, 14)],
    ['a range from before the start', range(-1, 2)],
    ['a split with a taken id', split('c', 1)],
    ['a split with an empty id', split('', 1)],
    ['a split past the end', split('n', 99)],
    ['merging the first block', { kind: 'mergeBlocks', blockId: 'a' }],
    ['heading level 0', { kind: 'setType', blockId: 'b', ...heading(0) }],
    ['heading level 7', { kind: 'setType', blockId: 'b', ...heading(7) }],
    ['heading level 1.5', { kind: 'setType', blockId: 'b', ...heading(1.5) }],
    ['a heading with no level', { kind: 'setType', blockId: 'b', type: 'heading', props: {} }],
    ['an unknown block type', { kind: 'setType', blockId: 'b', type: 'table', props: {} }],
    ['a split into an unknown type', split('n', 1, { type: 'list', props: {} })],
    ['a split into heading level 9', split('n', 1, heading(9))],
    ['props on a paragraph', { kind: 'setType', blockId: 'a', type: 'paragraph', props: { a: 1 } }],
    ['text in a field the block has not', insert('x', 0, 'label')],
    ['text in an inherited field', insert('x', 0, 'constructor')],
    ['text in the prototype field', insert('x', 0, '__proto__')],
    ['a split of a field the block has not', split('n', 1, paragraph, 'level')],
  ];

  it.each(refused)('refuses %s', (_name, op) => {
    const before = blocks(start);
    expect(() => apply(start, op)).toThrow(RangeError);
    expect(blocks(start)).toEqual(before);
  });

  it.each([
    ['setting the kind a block already has', { kind: 'setType', blockId: 'b', ...paragraph }],
    [
      'setting the level a heading already has',
      { kind: 'setType', blockId: 'a', type: 'heading', props: { level: 1 } },
    ],
    ['turning raw source into plain text', { kind: 'setType', blockId: 'c', ...paragraph }],
    [
      'turning plain text into raw source',
      { kind: 'setType', blockId: 'b', type: 'raw', props: {} },
    ],
    ['merging plain text into raw source', { kind: 'mergeBlocks', blockId: 'd' }],
    ['merging raw source into plain text', { kind: 'mergeBlocks', blockId: 'c' }],
    [
      'splitting raw source into plain text',
      { kind: 'splitBlock', blockId: 'c', field: 'text', offset: 5, newId: 'n', ...paragraph },
    ],
    [
      'splitting plain text into raw source',
      {
        kind: 'splitBlock',
        blockId: 'b',
        field: 'text',
        offset: 4,
        newId: 'n',
        type: 'raw',
        props: {},
      },
    ],
  ] satisfies [string, Op][])('refuses %s', (_name, op) => {
    const doc = docOf([
      ...blocks(start),
      { id: 'd', type: 'paragraph', props: {}, fields: { text: '<b onclick=x>' } },
    ]);
    const before = blocks(doc);
    expect(() => apply(doc, op)).toThrow(RangeError);
    expect(blocks(doc)).toEqual(before);
  });

  it('refuses props whose schema answers later', () => {
    const later: AnyComponent = {
      name: 'later',
      props: {
        '~standard': { version: 1, vendor: 'test', validate: async (value) => ({ value }) },
      },
      fields: ['text'],
      markdown: {
        match: 'leafDirective:later',
        read: () => undefined,
        write: () => ({ type: 'paragraph', children: [] }),
      },
    };
    const op: Op = { kind: 'setType', blockId: 'b', type: 'later', props: {} };
    expect(() => apply(start, op, registryOf([later]))).toThrow(RangeError);
  });

  it('moves no text between raw source and plain text, so an empty block may cross', () => {
    const doc = docOf([...blocks(start), { id: 'd', ...paragraph, fields: { text: '' } }]);
    const split = apply(doc, {
      kind: 'splitBlock',
      blockId: 'c',
      field: 'text',
      offset: 11,
      newId: 'n',
      ...paragraph,
    });
    expect(split.doc.blocks.get('n')).toEqual({ id: 'n', ...paragraph, fields: { text: '' } });
    expect(apply(split.doc, split.inverse).doc.ids).toEqual(doc.ids);
    const merged = apply(doc, { kind: 'mergeBlocks', blockId: 'd' });
    expect(blocks(merged.doc).at(-1)).toEqual(start.blocks.get('c'));
    const raw = apply(doc, { kind: 'setType', blockId: 'd', type: 'raw', props: {} });
    expect(raw.doc.blocks.get('d')).toEqual({
      id: 'd',
      type: 'raw',
      props: {},
      fields: { text: '' },
    });
  });

  it.each([
    ['text as a number', '{"kind":"insertText","blockId":"b","field":"text","offset":0,"text":1}'],
    [
      'text as an array',
      '{"kind":"insertText","blockId":"b","field":"text","offset":0,"text":["<script>"]}',
    ],
    [
      'text as an object',
      '{"kind":"insertText","blockId":"b","field":"text","offset":0,"text":{"length":0}}',
    ],
    ['a missing text', '{"kind":"insertText","blockId":"b","field":"text","offset":0}'],
    ['a missing field', '{"kind":"insertText","blockId":"b","offset":0,"text":"x"}'],
    [
      'offsets as strings',
      '{"kind":"deleteText","blockId":"b","field":"text","from":"0","to":"1"}',
    ],
    [
      'a null new id',
      '{"kind":"splitBlock","blockId":"b","field":"text","offset":0,"newId":null,"type":"paragraph","props":{}}',
    ],
    [
      'a number new id',
      '{"kind":"splitBlock","blockId":"b","field":"text","offset":0,"newId":7,"type":"paragraph","props":{}}',
    ],
    [
      'an object new id',
      '{"kind":"splitBlock","blockId":"b","field":"text","offset":0,"newId":{"a":1},"type":"paragraph","props":{}}',
    ],
    ['a null type', '{"kind":"setType","blockId":"b","type":null,"props":{}}'],
    ['missing props', '{"kind":"setType","blockId":"b","type":"paragraph"}'],
    ['a string level', '{"kind":"setType","blockId":"b","type":"heading","props":{"level":"1"}}'],
    [
      'a level next to a prototype key',
      '{"kind":"setType","blockId":"b","type":"heading","props":{"level":2,"__proto__":{"level":7}}}',
    ],
    ['a number id', '{"kind":"mergeBlocks","blockId":7}'],
    ['an unknown op', '{"kind":"evil","blockId":"b"}'],
    ['no op at all', 'null'],
  ])('refuses an op with %s', (_name, json) => {
    const before = blocks(start);
    expect(() => apply(start, JSON.parse(json))).toThrow(RangeError);
    expect(blocks(start)).toEqual(before);
    expect(Reflect.get({}, 'level')).toBeUndefined();
  });

  it('refuses props that are not JSON', () => {
    const cyclic: Record<string, unknown> = { level: 2 };
    cyclic.self = cyclic;
    for (const props of [{ level: Number.NaN }, { level: 2, at: new Date(0) }, cyclic]) {
      const op = { kind: 'setType', blockId: 'b', type: 'heading', props };
      expect(() => apply(start, op as Op)).toThrow(RangeError);
    }
    expect(start.blocks.get('b')?.type).toBe('paragraph');
  });

  it('refuses to join or cut raw source, so a fence never runs into the next block', () => {
    const doc = docOf([
      { id: 'r', type: 'raw', props: {}, fields: { text: '```js\nx\n```' } },
      { id: 's', type: 'raw', props: {}, fields: { text: '- item' } },
      { id: 'e', type: 'raw', props: {}, fields: { text: '' } },
    ]);
    const before = blocks(doc);
    const cutAt = (blockId: string, offset: number): Op => ({
      kind: 'splitBlock',
      blockId,
      field: 'text',
      offset,
      newId: 'n',
      type: 'raw',
      props: {},
    });
    expect(() => apply(doc, { kind: 'mergeBlocks', blockId: 's' })).toThrow(RangeError);
    expect(() => apply(doc, cutAt('r', 5))).toThrow(RangeError);
    expect(blocks(doc)).toEqual(before);
    expect(apply(doc, { kind: 'mergeBlocks', blockId: 'e' }).doc.ids).toEqual(['r', 's']);
    const cut = apply(doc, cutAt('s', 6));
    expect(blocks(apply(cut.doc, cut.inverse).doc)).toEqual(before);
  });

  it('refuses a cut inside a surrogate pair', () => {
    const emoji = docOf([{ id: 'e', ...paragraph, fields: { text: 'a😀b' } }]);
    const at = { blockId: 'e', field: 'text' };
    expect(() => apply(emoji, { kind: 'deleteText', ...at, from: 1, to: 2 })).toThrow(RangeError);
    expect(() => apply(emoji, { kind: 'insertText', ...at, offset: 2, text: 'x' })).toThrow(
      RangeError,
    );
    expect(() =>
      apply(emoji, { kind: 'splitBlock', ...at, offset: 2, newId: 'n', type: 'raw', props: {} }),
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
      expect(removed, where).toEqual(op.kind === 'mergeBlocks' ? [op.blockId] : []);
      expect(added, where).toEqual(op.kind === 'splitBlock' ? [op.newId] : []);
      for (const id of after.ids) {
        if (id !== op.blockId && !added.includes(id) && op.kind !== 'mergeBlocks') {
          expect(after.blocks.get(id), where).toBe(doc.blocks.get(id));
        }
      }
      doc = after;
    }
  });
});
