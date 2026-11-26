import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { docOf } from '../src/core/model.ts';
import { createEditor } from '../src/core/store.ts';
import type { AnyComponent, CollabAdapter, Doc, Editor, Mark, Op } from '../src/core/types.ts';
import { callout, counter, kinds, marked, randomOp, safeHref, seeded, seeds } from './generate.ts';

export type Peer = { readonly editor: Editor; deliver(count: number): Promise<void> };

export type Session = {
  readonly peers: readonly Peer[];
  settle(): Promise<void>;
  joiner(): Promise<Editor>;
  raw(): Promise<CollabAdapter>;
  close(): void;
};

export type Open = (count: number, source: Doc) => Promise<Session>;

export const page = 'Before.\n\n:::callout{tone="info"}\nFirst\n\nSecond\n:::\n\nAfter.\n';
const exclaimed: AnyComponent = {
  ...callout,
  transform: (op) => (op.kind === 'insertText' && op.text === '?' ? [{ ...op, text: '!' }] : []),
};
export const components = [exclaimed, marked];
export { safeHref };
export const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

const typing = { kind: 'insertText', field: 'text' } as const;
export const type = (blockId: string, offset: number, text: string) => ({
  ...typing,
  blockId,
  offset,
  text,
});
export const remove = (blockId: string) => ({ kind: 'removeBlock', blockId }) as const;
export const at = (blockId: string, offset: number) =>
  ({ ...typing, kind: 'text', blockId, from: offset, to: offset }) as const;
export const replaced = (text: string) => page.replace('Before.', text);
export const blank = { type: 'callout', props: { tone: 'info' } };

const docFrom = (markdown: string) =>
  createEditor(markdown, { now: () => 0, newId: counter(), components, safeHref }).doc();

export function convergence(open: Open, seedsRun: readonly number[] = seeds) {
  async function peers(count: number, source: string | Doc = page) {
    errors.mockClear();
    const session = await open(count, typeof source === 'string' ? docFrom(source) : source);
    onTestFinished(() => session.close());
    const converged = async () => {
      await session.settle();
      const room = await session.joiner();
      await vi.waitFor(
        () => {
          for (const { editor } of session.peers) {
            expect(editor.markdown()).toEqual(room.markdown());
            expect(editor.doc().blocks).toEqual(room.doc().blocks);
          }
        },
        { timeout: 10_000, interval: 20 },
      );
      expect(errors).not.toHaveBeenCalled();
      return room.markdown();
    };
    return { all: session.peers, converged, session };
  }

  describe('peers editing at once', () => {
    const plain = kinds.filter((kind) => kind.type !== 'raw');
    const variants = {
      'plain text': { kinds: plain, line: (text: string) => text, blank, saves: true },
      'marked text': {
        kinds: [{ type: marked.name, props: {} }],
        line: (text: string) => `::marked{text="${text}"}`,
        blank: undefined,
        saves: false,
      },
    };

    it.each(
      seedsRun.flatMap((seed) =>
        [2, 3].flatMap((count) =>
          (['plain text', 'marked text'] as const).map((on) => [seed, count, on] as const),
        ),
      ),
    )('converge on the room document (seed %i, %i peers, %s)', async (seed, count, on) => {
      const variant = variants[on];
      const random = seeded(seed);
      const body = Array.from({ length: 2 + random.int(4) }, (_, i) => variant.line(`Line ${i}`));
      const { all, converged } = await peers(count, body.join('\n\n'));
      const ids = all.map((_, client) => counter(`c${client}-`));
      for (let step = 0; step < 60; step += 1) {
        const client = random.int(count);
        const { editor, deliver } = all[client];
        if (random.int(3) === 0) await deliver(random.int(3));
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
      const saved = await converged();
      if (variant.saves) expect(saved.ok).toBe(true);
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
    ])('keeps peers converged when %s', async (_name, mine, theirs, markdown) => {
      const { all, converged } = await peers(2);
      all[0].editor.dispatch(mine);
      all[1].editor.dispatch(...theirs);
      expect(await converged()).toEqual({ ok: true, markdown });
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
    ])('converge when %s', async (_name, mine, theirs) => {
      for (const count of [2, 3]) {
        const { all, converged } = await peers(count, notes);
        all[0].editor.dispatch(...mine);
        all[1].editor.dispatch(...theirs);
        await converged();
      }
    });

    it('keep the text and drop the marks a hostile peer sends', async () => {
      const { all, converged, session } = await peers(2, notes);
      const deep = `${'['.repeat(33)}${']'.repeat(33)}`;
      (await session.raw()).send([
        { ...type('m0', 0, 'a\nb'), marks: [{ type: 'code', from: 0, to: 3 }] },
        {
          ...type('m0', 0, 'x'),
          marks: [{ type: 'link', from: 0, to: 1, href: 'javascript:alert(1)' }],
        },
        {
          kind: 'markText',
          ...on,
          mark: 'color',
          from: 0,
          to: 4,
          spans: [{ from: 0, to: 4, color: '__proto__' }],
        },
        { ...type('m0', 0, 'y'), marks: [{ ...bold(0, 1), color: 'red' }] },
        {
          ...type('m0', 0, 'z]'),
          marks: [
            { type: 'code', from: 0, to: 2 },
            { type: 'color', from: 0, to: 2, color: 'red' },
          ],
        },
        {
          ...type('m0', 0, `${deep} `),
          marks: [
            { type: 'code', from: 0, to: 66 },
            { type: 'color', from: 0, to: 66, color: 'red' },
          ],
        },
        {
          ...type('m0', 0, '\\['.repeat(500)),
          marks: [{ type: 'color', from: 0, to: 1000, color: 'red' }],
        },
      ]);
      await converged();
      for (const { editor } of all) {
        expect(editor.doc().blocks.get('m0')).toEqual({
          ...notes.blocks.get('m0'),
          fields: { text: `${'\\['.repeat(500)}${deep} z]yxa\nbBold words here` },
          marks: {
            text: [
              bold(1074, 1078),
              { type: 'code', from: 1000, to: 1066 },
              { type: 'code', from: 1067, to: 1069 },
            ],
          },
        });
      }
    });
  });

  describe('collaborative undo', () => {
    it("undoes only the undoing peer's text on every peer, and redoes it", async () => {
      const { all, converged } = await peers(2);
      const [{ editor }, other] = all;
      editor.dispatch(type('b0', 0, 'A'));
      other.editor.dispatch(type('b0', 7, 'B'));
      await converged();
      expect(editor.undo()).toBe(true);
      expect(await converged()).toEqual({ ok: true, markdown: replaced('Before.B') });
      expect(editor.command('redo', {})).toBe(true);
      expect(await converged()).toEqual({ ok: true, markdown: replaced('ABefore.B') });
    });
  });
}
