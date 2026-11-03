import { describe, expect, it } from 'vitest';
import { paragraph } from '../src/core/paragraph.ts';
import { createEditor } from '../src/core/store.ts';
import type { AnyComponent, Editor, Handlers, Selection } from '../src/core/types.ts';
import { counter } from './generate.ts';

function editorAt(markdown: string, components: readonly AnyComponent[] = []): Editor {
  return createEditor(markdown, { now: () => 0, newId: counter(), components });
}

function saved(editor: Editor): string {
  const result = editor.markdown();
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.markdown;
}

function caret(blockId: string, offset: number, to = offset): Selection {
  return { kind: 'text', blockId, field: 'text', from: offset, to };
}

function select(editor: Editor, selection: Selection) {
  editor.store.set(editor.selection, selection);
}

function idAt(editor: Editor, index: number): string {
  const id = editor.store.get(editor.ids)[index];
  if (id === undefined) throw new Error(`no block at ${index}`);
  return id;
}

function withCommands(name: string, commands: Handlers): AnyComponent {
  return {
    ...paragraph,
    name,
    markdown: { ...paragraph.markdown, match: `leafDirective:${name}` },
    commands,
  };
}

describe('the default commands', () => {
  it('starts with the caret at the start of the first block', () => {
    const editor = editorAt('# Title\n\nbody\n');
    expect(editor.store.get(editor.selection)).toEqual(caret(idAt(editor, 0), 0));
  });

  it('splits a paragraph at the caret on a break and moves the caret into the new block', () => {
    const editor = editorAt('Meetup notes\n');
    const id = idAt(editor, 0);
    select(editor, caret(id, 4));
    expect(editor.command('insertBreak', {})).toBe(true);
    expect(saved(editor)).toBe('Meet\n\nup notes\n');
    const newId = idAt(editor, 1);
    expect(editor.store.get(editor.selection)).toEqual(caret(newId, 0));
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe('Meetup notes\n');
  });
});

describe('the command chain', () => {
  it('runs component handlers in list order before the default and lets next() reach it', () => {
    const calls: string[] = [];
    const outer = withCommands('outer', {
      insertBreak(_context, _args, next) {
        calls.push('outer');
        const lower = next();
        return lower && { ops: lower.ops.slice(0, 1) };
      },
    });
    const inner = withCommands('inner', {
      insertBreak(context, _args, next) {
        calls.push('inner');
        const lower = next();
        const [blockId = ''] = context.doc.ids;
        return (
          lower && { ops: [{ kind: 'insertText', blockId, field: 'text', offset: 0, text: 'x' }] }
        );
      },
    });
    const editor = editorAt('ab\n', [outer, inner]);
    select(editor, caret(idAt(editor, 0), 1));
    expect(editor.command('insertBreak', {})).toBe(true);
    expect(calls).toEqual(['outer', 'inner']);
    expect(saved(editor)).toBe('xab\n');
    expect(editor.store.get(editor.selection)).toEqual(caret(idAt(editor, 0), 1));
  });

  it('falls through a handler that returns undefined, calling each lower handler once', () => {
    const calls: string[] = [];
    const passing = withCommands('passing', {
      insertBreak(_context, _args, next) {
        calls.push('passing');
        next();
        return undefined;
      },
    });
    const declining = withCommands('declining', {
      insertBreak() {
        calls.push('declining');
        return undefined;
      },
    });
    const editor = editorAt('ab\n', [passing, declining]);
    select(editor, caret(idAt(editor, 0), 1));
    expect(editor.command('insertBreak', {})).toBe(true);
    expect(calls).toEqual(['passing', 'declining']);
    expect(saved(editor)).toBe('a\n\nb\n');
  });
});

function blocks(...ids: string[]): Selection {
  return { kind: 'blocks', ids };
}

const plain = 'one\n\ntwo\n';
const raw = '::foo{x=1}\n\npara\n';

describe('the default delete commands', () => {
  it.each([
    [
      'merges a block into the one before at its start',
      '# Title\n\nbody\n',
      caret('b1', 0),
      'deleteBackward',
      '# Titlebody\n',
      caret('b0', 5),
    ],
    [
      'deletes the code point before the caret',
      'a😀b\n',
      caret('b0', 3),
      'deleteBackward',
      'ab\n',
      caret('b0', 1),
    ],
    [
      'deletes a selected range backward',
      'abcd\n',
      caret('b0', 1, 3),
      'deleteBackward',
      'ad\n',
      caret('b0', 1),
    ],
    [
      'merges the next block at the end',
      'one\n\ntwo\n',
      caret('b0', 3),
      'deleteForward',
      'onetwo\n',
      caret('b0', 3),
    ],
    [
      'deletes the code point after the caret',
      'a😀b\n',
      caret('b0', 1),
      'deleteForward',
      'ab\n',
      caret('b0', 1),
    ],
    [
      'deletes a selected range',
      'abcd\n',
      caret('b0', 1, 3),
      'deleteSelection',
      'ad\n',
      caret('b0', 1),
    ],
    [
      'removes whole selected blocks',
      'one\n\ntwo\n\nthree\n',
      blocks('b0', 'b1'),
      'deleteBackward',
      'three\n',
      caret('b2', 0),
    ],
    [
      'removes the last blocks and ends on the block before',
      'one\n\ntwo\n\nthree\n',
      blocks('b1', 'b2'),
      'deleteForward',
      'one\n',
      caret('b0', 3),
    ],
    [
      'leaves one empty paragraph when every block is removed',
      'one\n\ntwo\n',
      blocks('b0', 'b1'),
      'deleteSelection',
      '',
      caret('b2', 0),
    ],
  ] as const)('%s in one undo step', (_name, markdown, selection, command, after, moved) => {
    const editor = editorAt(markdown);
    select(editor, selection);
    expect(editor.command(command, {})).toBe(true);
    expect(saved(editor)).toBe(after);
    expect(editor.store.get(editor.selection)).toEqual(moved);
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe(markdown);
    expect(editor.undo()).toBe(false);
  });

  it.each([
    ['deleting backward at the start of the first block', plain, caret('b0', 0), 'deleteBackward'],
    ['deleting forward at the end of the last block', plain, caret('b1', 3), 'deleteForward'],
    ['deleting a collapsed selection', plain, caret('b0', 1), 'deleteSelection'],
    ['breaking inside raw source', raw, caret('b0', 3), 'insertBreak'],
    ['deleting backward into raw source', raw, caret('b1', 0), 'deleteBackward'],
    ['deleting forward from raw source', raw, caret('b0', 10), 'deleteForward'],
  ] as const)('does nothing %s', (_name, markdown, selection, command) => {
    const editor = editorAt(markdown);
    select(editor, selection);
    expect(editor.command(command, {})).toBe(false);
    expect(saved(editor)).toBe(markdown);
    expect(editor.store.get(editor.selection)).toEqual(selection);
    expect(editor.undo()).toBe(false);
  });
});
