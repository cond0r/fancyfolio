import { describe, expect, it, vi } from 'vitest';
import { docOf } from '../src/core/model.ts';
import { createEditor } from '../src/core/store.ts';
import type { AnyComponent, Doc, Mark, Op, Presence, RemoteOp } from '../src/core/types.ts';
import { join, room } from './collab.ts';
import { callout, counter, kinds, marked, randomOp, safeHref, seeded, seeds } from './generate.ts';

const page = 'Before.\n\n:::callout{tone="info"}\nFirst\n\nSecond\n:::\n\nAfter.\n';
const exclaimed: AnyComponent = {
  ...callout,
  transform: (op) => (op.kind === 'insertText' && op.text === '?' ? [{ ...op, text: '!' }] : []),
};
const components = [exclaimed, marked];
const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

function peers(count: number, source: string | Doc = page) {
  errors.mockClear();
  const shared = room(source, components, safeHref);
  const all = Array.from({ length: count }, (_, client) => {
    const { adapter: collab, deliver, sent } = join(shared);
    const newId = counter(`p${client}-`);
    const options = { now: () => 0, newId, components, collab, safeHref };
    const editor = createEditor(shared.replica().doc, options);
    return { editor, deliver, sent };
  });
  const converged = () => {
    for (let moved = 1; moved > 0; ) moved = all.reduce((sum, peer) => sum + peer.deliver(), 0);
    const expected = shared.markdown();
    for (const { editor } of all) {
      expect(editor.markdown()).toEqual(expected);
      expect(editor.doc().blocks).toEqual(shared.doc().blocks);
    }
    expect(errors).not.toHaveBeenCalled();
    return expected;
  };
  return { all, converged, shared };
}

const typing = { kind: 'insertText', field: 'text' } as const;
const type = (blockId: string, offset: number, text: string) => ({
  ...typing,
  blockId,
  offset,
  text,
});
const remove = (blockId: string) => ({ kind: 'removeBlock', blockId }) as const;
const at = (blockId: string, offset: number) =>
  ({ ...typing, kind: 'text', blockId, from: offset, to: offset }) as const;
const replaced = (text: string) => page.replace('Before.', text);
const blank = { type: 'callout', props: { tone: 'info' } };

describe('peers editing at once', () => {
  const plain = kinds.filter((kind) => kind.type !== 'raw');
  const variants = {
    'plain text': { kinds: plain, line: (text: string) => text, blank },
    'marked text': {
      kinds: [{ type: marked.name, props: {} }],
      line: (text: string) => `::marked{text="${text}"}`,
      blank: undefined,
    },
  };

  it.each(
    seeds.flatMap((seed) =>
      [2, 3].flatMap((count) =>
        (['plain text', 'marked text'] as const).map((on) => [seed, count, on] as const),
      ),
    ),
  )('converge on the room document (seed %i, %i peers, %s)', (seed, count, on) => {
    const variant = variants[on];
    const random = seeded(seed);
    const body = Array.from({ length: 2 + random.int(4) }, (_, i) => variant.line(`Line ${i}`));
    const { all, converged } = peers(count, body.join('\n\n'));
    const ids = all.map((_, client) => counter(`c${client}-`));
    for (let step = 0; step < 60; step += 1) {
      const client = random.int(count);
      const { editor, deliver } = all[client];
      if (random.int(3) === 0) deliver(random.int(3));
      else
        editor.dispatch(
          randomOp(
            editor.doc(),
            random,
            ids[client],
            variant.kinds,
            true,
            undefined,
            variant.blank,
          ),
        );
    }
    expect(converged().ok).toBe(true);
  });

  it.each<[string, Op, readonly Op[], string]>([
    [
      'both type at one offset',
      type('b0', 0, 'A '),
      [type('b0', 0, 'B ')],
      replaced('A B Before.'),
    ],
    [
      'one deletes a range the other types into',
      { kind: 'deleteText', blockId: 'b0', field: 'text', from: 0, to: 6 },
      [type('b0', 3, 'x')],
      replaced('x.'),
    ],
    [
      'one moves a block the other is editing',
      { kind: 'moveBlock', blockId: 'b4', parent: null, index: 0 },
      [type('b4', 0, 'Z')],
      `ZAfter.\n\n${page.replace('\n\nAfter.', '')}`,
    ],
    [
      'one moves a block into a callout the other removes',
      { kind: 'moveBlock', blockId: 'b4', parent: { blockId: 'b1', slot: 'body' }, index: 2 },
      [remove('b2'), remove('b3'), remove('b1')],
      'Before.\n\nAfter.\n',
    ],
    [
      'one splits a block the other types in the tail of',
      { ...type('b0', 2, ''), kind: 'splitBlock', newId: 'n', type: 'paragraph', props: {} },
      [type('b0', 4, 'X')],
      replaced('BeX\n\nfore.'),
    ],
  ])('keeps peers converged when %s', (_name, mine, theirs, markdown) => {
    const { all, converged } = peers(2);
    all[0].editor.dispatch(mine);
    all[1].editor.dispatch(...theirs);
    expect(converged()).toEqual({ ok: true, markdown });
  });

  it.each([
    ['an insert before the caret shifts it', at('b4', 3), type('b4', 0, 'xy'), at('b4', 5)],
    ['an insert at the caret leaves it before', at('b4', 3), type('b4', 3, 'xy'), at('b4', 3)],
    ['its block is removed, to the next block', at('b2', 2), remove('b2'), at('b3', 0)],
    ['its block is removed, to the previous one', at('b3', 2), remove('b3'), at('b2', 0)],
  ])('maps the caret when %s', (_name, start, op, expected) => {
    const { all, converged } = peers(2);
    const [{ editor }, other] = all;
    editor.store.set(editor.selection, start);
    other.editor.dispatch(op);
    converged();
    expect(editor.store.get(editor.selection)).toEqual(expected);
  });
});

describe('peers formatting at once', () => {
  const bold = (from: number, to: number): Mark => ({ type: 'bold', from, to });
  const notes = docOf([
    {
      id: 'm0',
      type: 'marked',
      props: {},
      fields: { text: 'Bold words here' },
      marks: { text: [bold(0, 4)] },
    },
    {
      id: 'm1',
      type: 'marked',
      props: {},
      fields: { text: 'tail' },
      marks: { text: [{ type: 'italic', from: 0, to: 4 }] },
    },
  ]);
  const on = { blockId: 'm0', field: 'text' } as const;
  const marking = (mark: Mark['type'], from: number, to: number, spans = [{ from, to }]): Op => ({
    kind: 'markText',
    ...on,
    mark,
    from,
    to,
    spans,
  });

  it.each<[string, readonly Op[], readonly Op[]]>([
    ['A bolds [2,7) while B types at 4', [marking('bold', 2, 7)], [type('m0', 4, 'xy')]],
    [
      'A deletes a bold range B extends',
      [{ kind: 'deleteText', ...on, from: 0, to: 4 }],
      [marking('bold', 0, 8)],
    ],
    [
      'A splits a marked block while B formats its tail',
      [{ kind: 'splitBlock', ...on, offset: 5, newId: 'n', type: 'marked', props: {} }],
      [marking('italic', 6, 10)],
    ],
    [
      'A merges a marked block and B keeps its marks',
      [{ kind: 'mergeBlocks', blockId: 'm1' }],
      [{ ...type('m1', 2, 'z'), marks: [bold(0, 1)] }],
    ],
    [
      'both set one type over overlapping ranges',
      [marking('bold', 2, 9, [])],
      [marking('bold', 6, 12)],
    ],
  ])('converge when %s', (_name, mine, theirs) => {
    for (const count of [2, 3]) {
      const { all, converged } = peers(count, notes);
      all[0].editor.dispatch(...mine);
      all[1].editor.dispatch(...theirs);
      converged();
    }
  });

  it('keep the text and drop the marks a hostile peer sends', () => {
    const { all, converged, shared } = peers(2, notes);
    join(shared).adapter.send([
      { ...type('m0', 0, 'a\nb'), marks: [{ type: 'code', from: 0, to: 3 }] },
      {
        ...type('m0', 0, 'x'),
        marks: [{ type: 'link', from: 0, to: 1, href: 'javascript:alert(1)' }],
      },
    ]);
    converged();
    for (const { editor } of all) {
      expect(editor.doc().blocks.get('m0')).toEqual({
        ...notes.blocks.get('m0'),
        fields: { text: 'xa\nbBold words here' },
        marks: { text: [bold(4, 8)] },
      });
    }
  });
});

describe('a room', () => {
  const empty: Doc = { ids: [], blocks: new Map(), sources: new Map() };

  it('takes the first character typed into an empty room as one paragraph', () => {
    const { all, converged } = peers(2, empty);
    const [{ editor }] = all;
    expect(editor.store.get(editor.selection)).toEqual({ kind: 'blocks', ids: [] });
    expect(converged()).toEqual({ ok: true, markdown: '' });
    expect(editor.command('insertText', { text: 'a' })).toBe(true);
    expect(converged()).toEqual({ ok: true, markdown: 'a\n' });
    expect(all.map((peer) => peer.editor.doc().ids.length)).toEqual([1, 1]);
    expect(editor.undo()).toBe(true);
    expect(converged()).toEqual({ ok: true, markdown: '' });
  });

  const near = (from: number, to = from): Presence => ({
    userId: 'u1',
    blockId: 'b4',
    field: 'text',
    from,
    to,
  });
  const emptied = { kind: 'deleteText', blockId: 'b4', field: 'text', from: 0, to: 6 } as const;

  it.each<[string, 0 | 1, readonly Op[], readonly Presence[]]>([
    ['a peer inserts before it', 1, [type('b4', 0, 'xy')], [near(4, 6)]],
    ['a peer inserts at it', 1, [type('b4', 2, 'xy')], [near(2, 6)]],
    ['the editor inserts before it', 0, [type('b4', 1, 'xy')], [near(4, 6)]],
    ['a peer removes its block', 1, [remove('b4')], []],
    [
      'a peer sets its block to a type without its field',
      1,
      [emptied, { kind: 'setType', blockId: 'b4', ...blank }],
      [],
    ],
  ])('maps a presence when %s', (_name, by, ops, expected) => {
    const { all, converged } = peers(2);
    const [{ editor }] = all;
    editor.setPresence([{ ...near(0), blockId: 'b0' }]);
    editor.setPresence([near(2, 4)]);
    all[by].editor.dispatch(...ops);
    converged();
    expect(editor.store.get(editor.presence('b4'))).toEqual(expected);
    expect(editor.store.get(editor.presence('b0'))).toEqual([]);
  });

  it('neither takes nor sends ops after disconnect', () => {
    const { all } = peers(2);
    const [{ editor, deliver, sent }, other] = all;
    editor.disconnect();
    other.editor.dispatch(type('b0', 0, 'x'));
    other.deliver();
    deliver();
    editor.dispatch(type('b0', 0, 'y'));
    expect(editor.command('insertText', { text: 'z' })).toBe(false);
    expect(editor.undo()).toBe(false);
    expect(sent).toEqual([]);
    expect(editor.markdown()).toEqual({ ok: true, markdown: page });
  });
});

describe('collaborative undo', () => {
  it("undoes only the undoing peer's text on every peer, and redoes it", () => {
    const { all, converged } = peers(2);
    const [{ editor }, other] = all;
    editor.dispatch(type('b0', 0, 'A'));
    other.editor.dispatch(type('b0', 7, 'B'));
    converged();
    expect(editor.undo()).toBe(true);
    expect(converged()).toEqual({ ok: true, markdown: replaced('Before.B') });
    expect(editor.command('redo', {})).toBe(true);
    expect(converged()).toEqual({ ok: true, markdown: replaced('ABefore.B') });
  });

  it('sends a step a transform extends once and undoes it as one step', () => {
    const { all, converged } = peers(2);
    const [{ editor, sent }] = all;
    editor.dispatch(type('b0', 0, '?'));
    expect(sent).toEqual([[type('b0', 0, '?'), type('b0', 0, '!')]]);
    expect(converged()).toEqual({ ok: true, markdown: replaced('!?Before.') });
    expect(editor.undo()).toBe(true);
    expect(converged()).toEqual({ ok: true, markdown: page });
  });

  const heading = { type: 'heading', props: { level: 2 } };
  it.each<[string, readonly Op[]]>([
    ['an op on a missing block', [type('b0', 0, 'x'), remove('missing')]],
    ['a type without a field for its text', [{ kind: 'setType', blockId: 'b0', ...blank }]],
    ['a type without a slot for its blocks', [{ kind: 'setType', blockId: 'b1', ...heading }]],
  ])('sends nothing for a dispatch the editor refuses (%s)', (_name, ops) => {
    const [{ editor, sent }] = peers(1).all;
    expect(() => editor.dispatch(...ops)).toThrow(RangeError);
    expect(sent).toEqual([]);
  });
});

describe('remote ops', () => {
  it('drops an op on a missing block silently, logs any other refusal and applies the rest raw', () => {
    errors.mockClear();
    let deliver: (ops: readonly RemoteOp[]) => void = () => undefined;
    const collab = {
      send: () => undefined,
      onRemote(apply: typeof deliver) {
        deliver = apply;
        return () => undefined;
      },
      undo: () => false,
      redo: () => false,
    };
    const editor = createEditor(page, { now: () => 0, newId: counter(), components, collab });
    deliver([
      type('gone', 0, 'x'),
      { ...type('b0', 0, 'x'), field: 'nope' },
      type('b0', 0, 'kept '),
      { kind: 'setType', blockId: 'b1', type: 'heading', props: { level: 2 } },
    ]);
    expect(errors).toHaveBeenCalledOnce();
    const markdown = 'kept Before.\n\n##\n\nFirst\n\nSecond\n\nAfter.\n';
    expect(editor.markdown()).toEqual({ ok: true, markdown });
  });
});
