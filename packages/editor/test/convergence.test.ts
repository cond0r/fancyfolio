import { describe, expect, it } from 'vitest';
import { createEditor } from '../src/core/store.ts';
import type { Doc, Op, Presence, RemoteOp } from '../src/core/types.ts';
import { join, room } from './collab.ts';
import {
  at,
  blank,
  components,
  convergence,
  errors,
  page,
  remove,
  replaced,
  safeHref,
  type,
} from './convergence.ts';
import { counter } from './generate.ts';

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

convergence(async (count, source) => {
  const { all, shared } = peers(count, source);
  const deliveries = all.map((peer) => peer.deliver);
  return {
    peers: all.map(({ editor, deliver }) => ({
      editor,
      deliver: async (messages) => {
        deliver(messages);
      },
    })),
    settle: async () => {
      for (let moved = 1; moved > 0; ) moved = deliveries.reduce((sum, each) => sum + each(), 0);
    },
    joiner: async () =>
      createEditor(shared.doc(), { now: () => 0, newId: counter('j-'), components, safeHref }),
    raw: async () => {
      const { adapter, deliver } = join(shared);
      deliveries.push(deliver);
      return adapter;
    },
    close: () => undefined,
  };
});

describe('peers editing at once', () => {
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
