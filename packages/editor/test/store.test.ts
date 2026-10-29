import { describe, expect, it } from 'vitest';
import { emptyHistory, record, redo, undo } from '../src/core/history.ts';
import { apply } from '../src/core/ops.ts';
import { createEditor } from '../src/core/store.ts';
import type { Block, Editor, Op } from '../src/core/types.ts';
import { counter, docProblems, randomOp, seeded, seeds, snapshot } from './generate.ts';

function editorAt(markdown: string, clock = { now: 0 }): Editor {
  return createEditor(markdown, { now: () => clock.now, newId: counter() });
}

function saved(editor: Editor): string {
  const result = editor.markdown();
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.markdown;
}

const body = '# Title\n\nMeet at 10:30\n\n| a |\n| - |\n| 1 |\n';

function idAt(editor: ReturnType<typeof createEditor>, index: number): string {
  const id = editor.store.get(editor.ids)[index];
  if (id === undefined) throw new Error(`no block at ${index}`);
  return id;
}

function state(editor: ReturnType<typeof createEditor>) {
  const ids = editor.store.get(editor.ids);
  const blocks = ids.map((id) => {
    const atom = editor.blocks.get(id);
    if (atom === undefined) throw new Error(`no atom for ${id}`);
    return editor.store.get(atom);
  });
  return { ids, blocks };
}

describe('the editor store', () => {
  it('loads markdown into one atom per block and saves it back', () => {
    const editor = editorAt(body);
    expect(editor.store.get(editor.ids)).toHaveLength(3);
    expect([...editor.blocks.keys()]).toEqual(editor.store.get(editor.ids));
    expect(saved(editor)).toBe(body);
  });

  it('keeps every editor in its own store', () => {
    const one = editorAt('one\n');
    const two = editorAt('two\n');
    one.dispatch({ type: 'insertText', id: idAt(one, 0), offset: 3, text: '!' });
    expect(saved(one)).toBe('one!\n');
    expect(saved(two)).toBe('two\n');
    expect(one.store).not.toBe(two.store);
  });

  it('writes only the atom of the block an op changes', () => {
    const editor = editorAt(body);
    const [first, second, third] = editor.store.get(editor.ids);
    const seen: string[] = [];
    for (const id of [first, second, third]) {
      const atom = id === undefined ? undefined : editor.blocks.get(id);
      if (atom !== undefined) editor.store.sub(atom, () => seen.push(id as string));
    }
    let orders = 0;
    editor.store.sub(editor.ids, () => {
      orders += 1;
    });
    editor.dispatch({ type: 'insertText', id: second as string, offset: 0, text: 'x' });
    expect(seen).toEqual([second]);
    expect(orders).toBe(0);
  });

  it('adds the new block atom before the order lists it and drops it after', () => {
    const editor = editorAt('ab\n');
    const id = idAt(editor, 0);
    const missing: string[] = [];
    editor.store.sub(editor.ids, () => {
      for (const each of editor.store.get(editor.ids)) {
        if (!editor.blocks.has(each)) missing.push(each);
      }
    });
    editor.dispatch({ type: 'splitBlock', id, offset: 1, newId: 'n', kind: { type: 'paragraph' } });
    expect(state(editor).blocks.map((block) => block.text)).toEqual(['a', 'b']);
    editor.dispatch({ type: 'mergeBlocks', id: 'n' });
    expect(missing).toEqual([]);
    expect([...editor.blocks.keys()]).toEqual([id]);
  });

  it('refuses a bad op without changing a thing', () => {
    const editor = editorAt(body);
    const before = state(editor);
    expect(() => editor.dispatch({ type: 'mergeBlocks', id: idAt(editor, 0) })).toThrow(RangeError);
    expect(state(editor)).toEqual(before);
    expect(editor.undo()).toBe(false);
  });

  it('holds only live blocks after 10,000 insert and delete cycles', () => {
    const editor = editorAt('ab\n');
    const id = idAt(editor, 0);
    const sizes = new Set<number>();
    for (let cycle = 0; cycle < 10_000; cycle += 1) {
      const newId = `n${cycle}`;
      editor.dispatch({ type: 'splitBlock', id, offset: 1, newId, kind: { type: 'paragraph' } });
      sizes.add(editor.blocks.size);
      editor.dispatch({ type: 'mergeBlocks', id: newId });
    }
    expect([...sizes]).toEqual([2]);
    expect([...editor.blocks.keys()]).toEqual([id]);
    expect(editor.store.get(editor.ids)).toEqual([id]);
    expect(saved(editor)).toBe('ab\n');
  });
});

describe('undo and redo', () => {
  it('makes consecutive typing in one block one undo step', () => {
    const editor = editorAt('Meet\n');
    const id = idAt(editor, 0);
    for (const [offset, text] of [
      [4, ' '],
      [5, 'a'],
      [6, 't'],
      [7, ' 10:30'],
    ] as const) {
      editor.dispatch({ type: 'insertText', id, offset, text });
    }
    expect(saved(editor)).toBe('Meet at 10:30\n');
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe('Meet\n');
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(true);
    expect(saved(editor)).toBe('Meet at 10:30\n');
    expect(editor.redo()).toBe(false);
  });

  it('starts a new step when typing jumps, changes block or follows another op', () => {
    const editor = editorAt('ab\n\ncd\n');
    const [first, second] = editor.store.get(editor.ids) as [string, string];
    editor.dispatch({ type: 'insertText', id: first, offset: 2, text: 'x' });
    editor.dispatch({ type: 'insertText', id: first, offset: 0, text: 'y' });
    editor.dispatch({ type: 'insertText', id: second, offset: 0, text: 'z' });
    editor.dispatch({ type: 'deleteText', id: second, from: 0, to: 1 });
    editor.dispatch({ type: 'insertText', id: second, offset: 0, text: 'w' });
    const saves = [saved(editor)];
    while (editor.undo()) saves.push(saved(editor));
    expect(saves).toEqual([
      'yabx\n\nwcd\n',
      'yabx\n\ncd\n',
      'yabx\n\nzcd\n',
      'yabx\n\ncd\n',
      'abx\n\ncd\n',
      'ab\n\ncd\n',
    ]);
  });

  it('does not join typing after an undo to the step before it', () => {
    const editor = editorAt('a\n');
    const id = idAt(editor, 0);
    editor.dispatch({ type: 'insertText', id, offset: 1, text: 'b' });
    editor.dispatch({ type: 'splitBlock', id, offset: 2, newId: 'n', kind: { type: 'paragraph' } });
    editor.undo();
    editor.dispatch({ type: 'insertText', id, offset: 2, text: 'c' });
    editor.undo();
    expect(saved(editor)).toBe('ab\n');
    expect(editor.redo()).toBe(true);
    expect(saved(editor)).toBe('abc\n');
  });

  it('drops the redo steps when a new op follows an undo', () => {
    const editor = editorAt('a\n');
    const id = idAt(editor, 0);
    editor.dispatch({ type: 'setType', id, kind: { type: 'heading', level: 2 } });
    editor.undo();
    editor.dispatch({ type: 'insertText', id, offset: 0, text: 'x' });
    expect(editor.redo()).toBe(false);
    expect(saved(editor)).toBe('xa\n');
  });

  it.each(seeds)('restores exact states over random ops (seed %i)', (seed) => {
    const random = seeded(seed);
    const editor = editorAt(body);
    const states: { ids: readonly string[]; blocks: Block[] }[] = [state(editor)];
    let next = 0;
    for (let step = 0; step < 200; step += 1) {
      const op = randomOp(editor.doc(), random, () => `n${next++}`);
      const expected = apply(editor.doc(), op).doc;
      editor.dispatch(op);
      expect(docProblems(editor.doc()), `seed ${seed} step ${step}`).toEqual([]);
      expect(state(editor), `seed ${seed} step ${step}`).toEqual({
        ids: expected.ids,
        blocks: snapshot(expected),
      });
      states.push(state(editor));
    }
    const final = state(editor);
    const undone = [state(editor)];
    while (editor.undo()) undone.push(state(editor));
    expect(undone.at(-1), `seed ${seed}`).toEqual(states[0]);
    for (const seen of undone) expect(states, `seed ${seed}`).toContainEqual(seen);
    while (editor.redo());
    expect(state(editor), `seed ${seed}`).toEqual(final);
    expect(snapshot(editor.doc())).toEqual(final.blocks);
  });
});

describe('undo steps over a session', () => {
  it('starts a new step when typing pauses or the clock goes back', () => {
    const clock = { now: 0 };
    const editor = editorAt('a\n', clock);
    const id = idAt(editor, 0);
    editor.dispatch({ type: 'insertText', id, offset: 1, text: 'b' });
    clock.now = 900;
    editor.dispatch({ type: 'insertText', id, offset: 2, text: 'c' });
    clock.now = 1950;
    editor.dispatch({ type: 'insertText', id, offset: 3, text: 'd' });
    clock.now = 0;
    editor.dispatch({ type: 'insertText', id, offset: 4, text: 'e' });
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe('abcd\n');
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe('abc\n');
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe('a\n');
    expect(editor.undo()).toBe(false);
  });

  const typing: [string, [string, number][], string[]][] = [
    [
      'two seconds after its first keystroke',
      [
        ['a', 0],
        ['b', 900],
        ['c', 1800],
        ['d', 2700],
      ],
      ['abc', ''],
    ],
    [
      'at a typed newline',
      [
        ['a', 0],
        ['\n', 100],
        ['b', 200],
      ],
      ['a\n', ''],
    ],
  ];

  it.each(typing)('ends a step %s', (_name, typed, undone) => {
    const clock = { now: 0 };
    const editor = editorAt('', clock);
    const id = idAt(editor, 0);
    let offset = 0;
    for (const [text, at] of typed) {
      clock.now = at;
      editor.dispatch({ type: 'insertText', id, offset, text });
      offset += text.length;
    }
    const texts: string[] = [];
    while (editor.undo()) texts.push(state(editor).blocks[0]?.text ?? '');
    expect(texts).toEqual(undone);
  });

  it('keeps each op as dispatched when the caller changes it afterwards', () => {
    const editor = editorAt('a\n');
    const id = idAt(editor, 0);
    let text = 'x';
    const read = {
      type: 'insertText' as const,
      id,
      offset: 0,
      get text() {
        return text;
      },
    };
    const mutated: Op = { type: 'insertText', id, offset: 0, text: 'y' };
    editor.dispatch(read);
    editor.dispatch(mutated);
    text = '<script>';
    Object.assign(mutated, { offset: 9, text: '<script>' });
    expect(saved(editor)).toBe('yxa\n');
    expect(editor.undo() && editor.undo()).toBe(true);
    expect(saved(editor)).toBe('a\n');
    expect(editor.redo() && editor.redo()).toBe(true);
    expect(saved(editor)).toBe('yxa\n');
  });

  it('keeps the last 500 steps', () => {
    const editor = editorAt('a\n');
    const id = idAt(editor, 0);
    for (let step = 0; step < 600; step += 1) {
      editor.dispatch({ type: 'insertText', id, offset: 0, text: 'x' });
    }
    let undone = 0;
    while (editor.undo()) undone += 1;
    expect(undone).toBe(500);
    expect(saved(editor)).toBe(`${'x'.repeat(100)}a\n`);
  });

  it('refuses setting a block to the kind it has and keeps the redo steps', () => {
    const editor = editorAt('a\n');
    const id = idAt(editor, 0);
    editor.dispatch({ type: 'setType', id, kind: { type: 'heading', level: 2 } });
    editor.undo();
    expect(() => editor.dispatch({ type: 'setType', id, kind: { type: 'paragraph' } })).toThrow(
      RangeError,
    );
    expect(editor.redo()).toBe(true);
    expect(saved(editor)).toBe('## a\n');
  });

  it('gives a block its own atom back when undo or redo brings it back', () => {
    const editor = editorAt('ab\n');
    const id = idAt(editor, 0);
    editor.dispatch({ type: 'splitBlock', id, offset: 1, newId: 'n', kind: { type: 'paragraph' } });
    const atom = editor.blocks.get('n');
    editor.dispatch({ type: 'mergeBlocks', id: 'n' });
    expect(editor.blocks.has('n')).toBe(false);
    editor.undo();
    expect(editor.blocks.get('n')).toBe(atom);
    editor.redo();
    editor.undo();
    expect(editor.blocks.get('n')).toBe(atom);
    editor.undo();
    expect(editor.blocks.has('n')).toBe(false);
    editor.redo();
    expect(editor.blocks.get('n')).toBe(atom);
    expect(state(editor).blocks.map((block) => block.text)).toEqual(['a', 'b']);
  });

  it('refuses a malformed op from the wire and keeps undo working', () => {
    const editor = editorAt('Hello world\n');
    const id = idAt(editor, 0);
    const wire = `{"type":"insertText","id":${JSON.stringify(id)},"offset":0,"text":123}`;
    expect(() => editor.dispatch(JSON.parse(wire))).toThrow(RangeError);
    editor.dispatch({ type: 'insertText', id, offset: 0, text: 'x' });
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe('Hello world\n');
    expect(editor.undo()).toBe(false);
  });

  it('joins typing into a step that keeps only the op fields', () => {
    const first = JSON.parse('{"type":"insertText","id":"a","offset":0,"text":"x","extra":1}');
    const typed = record(emptyHistory, first, { type: 'deleteText', id: 'a', from: 0, to: 1 }, 0);
    const joined = record(
      typed,
      { type: 'insertText', id: 'a', offset: 1, text: 'y' },
      { type: 'deleteText', id: 'a', from: 1, to: 2 },
      10,
    );
    const undone = undo(joined);
    expect(undone?.op).toEqual({ type: 'deleteText', id: 'a', from: 0, to: 2 });
    expect(undone && redo(undone.history)?.op).toEqual({
      type: 'insertText',
      id: 'a',
      offset: 0,
      text: 'xy',
    });
  });
});
