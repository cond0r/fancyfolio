import { describe, expect, it, vi } from 'vitest';
import { createEditor } from '../src/core/store.ts';
import { childrenOf, depthOf, pathOf, placeOf } from '../src/core/tree.ts';
import type { AnyComponent, Doc, DocView, Op, Parent } from '../src/core/types.ts';
import { callout, counter, kinds, metric, randomOp, seeded, seeds } from './generate.ts';

const page =
  'Before.\n\n:::callout{tone="info"}\nFirst\n\nSecond\n:::\n\n:::callout{tone="warn"}\nThird\n:::\n\nAfter.\n';

function editorAt(markdown: string, components: readonly AnyComponent[] = [callout]) {
  return createEditor(markdown, { now: () => 0, newId: counter(), components });
}

function scanned(view: DocView): Map<string, Parent> {
  const parents = new Map<string, Parent>();
  const visit = (ids: readonly string[], parent: Parent) => {
    for (const id of ids) {
      parents.set(id, parent);
      for (const [slot, children] of Object.entries(view.blocks.get(id)?.slots ?? {})) {
        visit(children, { blockId: id, slot });
      }
    }
  };
  visit(view.ids, null);
  return parents;
}

describe('the parent index', () => {
  it.each(seeds)('matches a full scan after every seeded step and inside it (seed %i)', (seed) => {
    const random = seeded(seed);
    const newId = counter('n');
    const seen = new Set<string>();
    const matches = (view: DocView) => {
      const expected = scanned(view);
      for (const id of expected.keys()) seen.add(id);
      const links = (of: (id: string) => Parent | undefined) => [...seen].map((id) => [id, of(id)]);
      expect(links((id) => view.parentOf(id))).toEqual(links((id) => expected.get(id)));
      return [];
    };
    const markdown = { ...metric.markdown, match: 'leafDirective:probe' } as const;
    const transform = vi.fn((_op: Op, after: DocView) => matches(after));
    const probe: AnyComponent = { ...metric, name: 'probe', markdown, transform };
    const editor = editorAt(page, [callout, metric, probe]);
    const treeOp = (doc: Doc): Op => {
      const boxes = doc.ids.filter((id) => doc.blocks.get(id)?.slots !== undefined);
      const parent = random.pick<Parent>([
        null,
        ...boxes.map((blockId) => ({ blockId, slot: 'body' })),
      ]);
      const list = parent === null ? doc.ids : (doc.blocks.get(parent.blockId)?.slots?.body ?? []);
      const [blockId, index] = [random.pick([...doc.blocks.keys()]), random.int(list.length + 1)];
      const block = { id: newId(), type: 'paragraph', props: {}, fields: { text: '' } };
      return random.pick<Op>([
        { kind: 'moveBlock', blockId, parent, index },
        { kind: 'insertBlock', block, parent, index },
        { kind: 'removeBlock', blockId },
      ]);
    };
    for (let round = 0; round < 60; round += 1) {
      const doc = editor.doc();
      const op = () =>
        random.int(2) === 0 ? treeOp(doc) : randomOp(doc, random, newId, kinds, true);
      try {
        if (random.int(5) === 0) editor.undo();
        else editor.dispatch(...Array.from({ length: 1 + random.int(3) }, op));
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
      matches(editor.view);
    }
    expect(transform).toHaveBeenCalled();
  });

  it('finds a slot child in a 500-block doc reading at most depth + 1 blocks', () => {
    const paragraphs = Array.from({ length: 497 }, (_, i) => `Block ${i}`);
    const editor = editorAt(
      [...paragraphs, ':::callout{tone="info"}\nFirst\n\nLast\n:::'].join('\n\n'),
    );
    const { view } = editor;
    let reads = 0;
    const get = (id: string) => {
      reads += 1;
      return view.blocks.get(id);
    };
    const counting: DocView = { ...view, blocks: { get } };
    expect(placeOf(counting, 'b499')).toEqual({
      parent: { blockId: 'b497', slot: 'body' },
      list: ['b498', 'b499'],
      index: 1,
    });
    expect(reads).toBeLessThanOrEqual(2);
  });

  it.each([
    ['a top-level block', 'b0', ['b0'], 0, []],
    ['a callout', 'b1', ['b1'], 0, ['b2', 'b3']],
    ['a callout child', 'b3', ['b1', 'b3'], 1, []],
    ['an unknown id', 'missing', undefined, undefined, undefined],
  ])('reads the path, depth and children of %s', (_name, blockId, path, depth, children) => {
    const { view } = editorAt(page);
    expect([pathOf(view, blockId), depthOf(view, blockId), childrenOf(view, blockId)]).toEqual([
      path,
      depth,
      children,
    ]);
  });
});
