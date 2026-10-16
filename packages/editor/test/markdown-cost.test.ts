import type { Root } from 'mdast';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { load, save } from '../src/core/markdown.ts';
import { docOf } from '../src/core/model.ts';
import { apply } from '../src/core/ops.ts';
import { counter } from './generate.ts';

const calls = vi.hoisted(() => ({ parse: 0, stringify: 0 }));

vi.mock('../src/dialect.ts', async (importOriginal) => {
  const dialect = await importOriginal<typeof import('../src/dialect.ts')>();
  return {
    ...dialect,
    parseMarkdown(markdown: string) {
      calls.parse += 1;
      return dialect.parseMarkdown(markdown);
    },
    stringifyMarkdown(tree: Root) {
      calls.stringify += 1;
      return dialect.stringifyMarkdown(tree);
    },
  };
});

const body = `${Array.from({ length: 200 }, (_, i) => `Paragraph ${i}\n\n## Heading ${i}`).join('\n\n')}\n`;

describe('the cost of a save', () => {
  beforeEach(() => {
    calls.parse = 0;
    calls.stringify = 0;
  });

  it('writes an unedited body back without serializing or parsing it again', () => {
    const doc = load(body, counter());
    calls.parse = 0;
    expect(save(doc)).toEqual({ ok: true, markdown: body });
    expect(save(doc)).toEqual({ ok: true, markdown: body });
    expect(calls).toEqual({ parse: 0, stringify: 0 });
  });

  it('serializes only the edited block and parses the body once per save', () => {
    const doc = load(body, counter());
    const id = doc.ids[3] as string;
    const edited = apply(doc, { type: 'insertText', id, offset: 0, text: 'x' }).doc;
    calls.parse = 0;
    expect(save(edited)).toEqual({
      ok: true,
      markdown: body.replace('## Heading 1', '## xHeading 1'),
    });
    expect(calls).toEqual({ parse: 2, stringify: 1 });
    save(edited);
    expect(calls).toEqual({ parse: 3, stringify: 1 });
  });

  it('parses an edited body at most twice however many raw blocks are left open', () => {
    const open = Array.from(
      { length: 400 },
      (_, i) => ({ id: `r${i}`, type: 'raw', text: '```\nx' }) as const,
    );
    const doc = docOf([...open, { id: 'p', type: 'paragraph', text: 'typed' }]);
    calls.parse = 0;
    const result = save(doc);
    expect(calls.parse).toBeLessThanOrEqual(2);
    expect(result.ok).toBe(false);
  });
});
