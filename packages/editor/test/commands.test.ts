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
