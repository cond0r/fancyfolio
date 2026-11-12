import { describe, expect, it, vi } from 'vitest';
import { createEditor } from '../src/core/store.ts';
import type { AnyComponent, Op, RemoteOp } from '../src/core/types.ts';
import { join, room } from './collab.ts';
import { callout, counter, kinds, randomOp, seeded, seeds } from './generate.ts';

const page = 'Before.\n\n:::callout{tone="info"}\nFirst\n\nSecond\n:::\n\nAfter.\n';
const exclaimed: AnyComponent = {
  ...callout,
  transform: (op) => (op.kind === 'insertText' && op.text === '?' ? [{ ...op, text: '!' }] : []),
};
const components = [exclaimed];
const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

function peers(count: number, markdown = page) {
  errors.mockClear();
  const shared = room(markdown, components);
  const all = Array.from({ length: count }, () => {
    const { adapter: collab, deliver, sent } = join(shared);
    const editor = createEditor(markdown, { now: () => 0, newId: counter(), components, collab });
    return { editor, deliver, sent };
  });
  const converged = () => {
    for (let moved = 1; moved > 0; ) moved = all.reduce((sum, peer) => sum + peer.deliver(), 0);
    const expected = shared.markdown();
    for (const { editor } of all) expect(editor.markdown()).toEqual(expected);
    expect(errors).not.toHaveBeenCalled();
    return expected;
  };
  const held = (id: string) => all.every(({ editor }) => editor.doc().ids.includes(id));
  const spare = () => all[0].editor.doc().ids.filter(held).length > count;
  return { all, converged, spare };
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

describe('peers editing at once', () => {
  const plain = kinds.filter((kind) => kind.type !== 'raw');

  it.each(seeds.flatMap((seed) => [2, 3].map((count) => [seed, count])))(
    'converge on the room document (seed %i, %i peers)',
    (seed, count) => {
      const random = seeded(seed);
      const body = Array.from({ length: 2 + random.int(4) }, (_, i) => `Line ${i}`).join('\n\n');
      const { all, converged, spare } = peers(count, body);
      const ids = all.map((_, client) => counter(`c${client}-`));
      for (let step = 0; step < 60; step += 1) {
        const client = random.int(count);
        const { editor, deliver } = all[client];
        if (random.int(3) === 0) deliver(random.int(3));
        else editor.dispatch(randomOp(editor.doc(), random, ids[client], plain, true, spare()));
      }
      expect(converged().ok).toBe(true);
    },
  );

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

  it('sends nothing for a dispatch the editor refuses', () => {
    const [{ editor, sent }] = peers(1).all;
    expect(() => editor.dispatch(type('b0', 0, 'x'), remove('missing'))).toThrow(RangeError);
    expect(sent).toEqual([]);
  });
});

describe('remote ops', () => {
  it('drops an op on a missing block silently, logs any other refusal and applies the rest', () => {
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
    ]);
    expect(errors).toHaveBeenCalledOnce();
    expect(editor.markdown()).toEqual({ ok: true, markdown: `kept ${page}` });
  });
});
