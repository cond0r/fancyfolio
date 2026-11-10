import { describe, expect, it } from 'vitest';
import { spanOf } from '../src/dom/field.ts';

const paragraph = (id: string) => ({ id, type: 'paragraph', props: {}, fields: { text: id } });
const box = { id: 'c', type: 'box', props: {}, fields: {}, slots: { body: ['x', 'y'] } };
const blocks = new Map(
  [paragraph('a'), box, paragraph('x'), paragraph('y'), paragraph('b')].map((b) => [b.id, b]),
);
const view = { ids: ['a', 'c', 'b'], blocks };

describe('a drag between blocks', () => {
  it.each([
    ['from a slot child to a later block', 'x', 'b', ['c', 'b']],
    ['from an earlier block to a slot child', 'a', 'y', ['a', 'c']],
    ['between two children of one container', 'x', 'y', ['c']],
    ['across top-level blocks', 'b', 'a', ['a', 'c', 'b']],
  ])('selects whole top-level blocks %s', (_name, from, to, ids) => {
    expect(spanOf(view, from, to)).toEqual(ids);
  });
});
