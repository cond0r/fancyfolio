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
const rawLast = 'para\n\n::foo{x=1}\n';

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
    [
      'deleting backward from raw source into plain text',
      rawLast,
      caret('b1', 0),
      'deleteBackward',
    ],
    ['deleting forward from plain text into raw source', rawLast, caret('b0', 4), 'deleteForward'],
  ] as const)('does nothing %s', (_name, markdown, selection, command) => {
    const editor = editorAt(markdown);
    select(editor, selection);
    expect(editor.command(command, {})).toBe(false);
    expect(saved(editor)).toBe(markdown);
    expect(editor.store.get(editor.selection)).toEqual(selection);
    expect(editor.undo()).toBe(false);
  });
});

describe('raw source commands', () => {
  it('inserts a line break inside raw source in place of the selection', () => {
    const editor = editorAt(raw);
    select(editor, caret('b0', 5, 6));
    expect(editor.command('insertBreak', {})).toBe(true);
    expect(editor.doc().blocks.get('b0')?.fields.text).toBe('::foo\nx=1}');
    expect(editor.store.get(editor.ids)).toEqual(['b0', 'b1']);
    expect(editor.store.get(editor.selection)).toEqual(caret('b0', 6));
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe(raw);
  });

  it.each([
    [
      'backward from the block after raw source to its end',
      raw,
      caret('b1', 0),
      'deleteBackward',
      caret('b0', 10),
    ],
    [
      'forward from the end of raw source to the next block',
      raw,
      caret('b0', 10),
      'deleteForward',
      caret('b1', 0),
    ],
    [
      'backward from raw source to the end of the raw source before',
      '::foo{x=1}\n\n::bar\n',
      caret('b1', 0),
      'deleteBackward',
      caret('b0', 10),
    ],
  ] as const)('moves the caret %s with no op', (_name, markdown, selection, command, moved) => {
    const editor = editorAt(markdown);
    select(editor, selection);
    expect(editor.command(command, {})).toBe(true);
    expect(saved(editor)).toBe(markdown);
    expect(editor.store.get(editor.selection)).toEqual(moved);
    expect(editor.undo()).toBe(false);
  });
});

describe('typing and history commands', () => {
  it('types over a selected range and moves the caret after the text', () => {
    const editor = editorAt('abcd\n');
    select(editor, caret('b0', 1, 3));
    expect(editor.command('insertText', { text: 'XY' })).toBe(true);
    expect(saved(editor)).toBe('aXYd\n');
    expect(editor.store.get(editor.selection)).toEqual(caret('b0', 3));
    expect(editor.command('insertText', { text: '' })).toBe(false);
    select(editor, blocks('b0'));
    expect(editor.command('insertText', { text: 'z' })).toBe(false);
    expect(saved(editor)).toBe('aXYd\n');
  });

  it('undoes and redoes the history when no component claims the command', () => {
    const editor = editorAt('ab\n');
    expect(editor.command('undo', {})).toBe(false);
    select(editor, caret('b0', 2));
    editor.command('insertText', { text: 'c' });
    expect(editor.command('undo', {})).toBe(true);
    expect(saved(editor)).toBe('ab\n');
    expect(editor.command('redo', {})).toBe(true);
    expect(saved(editor)).toBe('abc\n');
    expect(editor.command('redo', {})).toBe(false);
  });

  it.each([
    ['typing', 'ab\n', caret('b0', 2), 'insertText', { text: 'c' }],
    ['a break', 'ab\n', caret('b0', 1), 'insertBreak', {}],
    ['a block removal', 'one\n\ntwo\n\nthree\n', blocks('b0', 'b1'), 'deleteSelection', {}],
  ] as const)(
    'restores the selection around %s on undo and redo',
    (_name, markdown, selection, command, args) => {
      const editor = editorAt(markdown);
      select(editor, selection);
      expect(editor.command(command, args)).toBe(true);
      const after = editor.store.get(editor.selection);
      select(editor, caret(idAt(editor, 0), 0));
      expect(editor.command('undo', {})).toBe(true);
      expect(editor.store.get(editor.selection)).toEqual(selection);
      select(editor, caret(idAt(editor, 0), 0));
      expect(editor.redo()).toBe(true);
      expect(editor.store.get(editor.selection)).toEqual(after);
    },
  );

  it('restores the selection before the first keystroke of joined typing', () => {
    const editor = editorAt('ab\n');
    select(editor, caret('b0', 2));
    editor.command('insertText', { text: 'c' });
    editor.command('insertText', { text: 'd' });
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe('ab\n');
    expect(editor.store.get(editor.selection)).toEqual(caret('b0', 2));
    expect(editor.redo()).toBe(true);
    expect(editor.store.get(editor.selection)).toEqual(caret('b0', 4));
  });

  it('dispatches a component result for undo instead of moving the history', () => {
    const claiming = withCommands('claiming', {
      undo: (context) => ({
        ops: [
          {
            kind: 'insertText',
            blockId: context.doc.ids[0] ?? '',
            field: 'text',
            offset: 0,
            text: 'u',
          },
        ],
      }),
    });
    const editor = editorAt('ab\n', [claiming]);
    expect(editor.command('undo', {})).toBe(true);
    expect(saved(editor)).toBe('uab\n');
    expect(editor.undo()).toBe(true);
    expect(saved(editor)).toBe('ab\n');
  });
});
