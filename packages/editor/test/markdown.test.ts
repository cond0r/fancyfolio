import type { Nodes, Root } from 'mdast';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { load, save } from '../src/core/markdown.ts';
import { type Block, type Doc, docOf } from '../src/core/model.ts';
import { apply, type Op } from '../src/core/ops.ts';
import { parseMarkdown, remarkDialect, remarkDirectiveAllowlist } from '../src/dialect.ts';
import {
  counter,
  docProblems,
  kinds,
  type Random,
  randomOp,
  randomText,
  seeded,
  seeds,
  snapshot,
} from './generate.ts';

const renderer = unified()
  .use(remarkParse)
  .use(remarkDialect)
  .use(remarkDirectiveAllowlist, { allow: [] })
  .use(remarkRehype)
  .use(rehypeStringify);

function render(markdown: string): string {
  return String(renderer.processSync(markdown));
}

function mdast(markdown: string): Root {
  return JSON.parse(
    JSON.stringify(parseMarkdown(markdown), (key, value) =>
      key === 'position' ? undefined : value,
    ),
  );
}

function shape(blocks: readonly Block[]) {
  return blocks.map(({ id: _id, ...rest }) => rest);
}

const newId = counter();

function loaded(markdown: string): Doc {
  return load(markdown, newId);
}

function output(doc: Doc): string {
  const result = save(doc);
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.markdown;
}

function roundTrip(markdown: string): string {
  return output(loaded(markdown));
}

const canonical = [
  '# Title\n\nA paragraph.\n',
  'Meet at 10:30, Status:done\n',
  '## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n',
  'First line\nsecond line\n',
  'Escaped \\* star, \\_under\\_ and \\[brackets]\n',
  ':\\:metric typed as text\n',
  'Set NODE_ENV:production and std::vector\n',
  '# Title\n\n- one\n- two\n\nAfter the list.\n',
  '| a | b |\n| - | - |\n| 1 | 2 |\n',
  '| a | b |\n| - | - |\n| 1 |\n',
  '<div class="x">\n  <span>html</span>\n</div>\n\nText.\n',
  'Inline <b>html</b> in a paragraph\n',
  '![A chart](https://example.test/chart.png)\n',
  'A claim[^1].\n\n[^1]: The source.\n',
  '::metric{value="40%" label="Latency"}\n',
  ':::callout{tone="info"}\nInside **a** callout\n:::\n',
  ':::unknown\n- item\n:::\n',
  '```ts\nconst a = 1;\n```\n',
  '    indented code\n',
  '> A quote\n> continued\n',
  'Some *emphasis* and a [link](https://example.test)\n',
  '---\n\nAfter a rule.\n',
  '1. first\n2. second\n',
  '[ref]: https://example.test\n\nSee [ref].\n',
  '* star bullets\n* stay as written\n',
  '<!-- a note -->\n\nText.\n',
  '- [ ] open task\n- [x] done task\n',
  `${'>'.repeat(60)}a\n`,
  `${Array.from({ length: 40 }, (_, i) => `${'\t'.repeat(i)}1. x`).join('\n')}\n`,
  `${'> '.repeat(60)}deep\n`,
];

const unmodelled = [
  ['a table', '| a |\n| - |\n| 1 |'],
  ['raw HTML', '<div>\nx\n</div>'],
  ['an image', '![a](https://example.test/a.png)'],
  ['a footnote definition', '[^1]: note'],
  ['a footnote reference', 'see[^1]\n\n[^1]: note'],
  ['a leaf directive', '::metric{value="3"}'],
  ['a container directive', ':::callout\ntext\n:::'],
  ['a list', '- a\n- b'],
  ['a quote', '> a'],
  ['a code fence', '```\ncode\n```'],
  ['a rule', '---'],
  ['a definition', '[a]: https://example.test'],
  ['emphasis', 'some *em*'],
  ['a hard break', 'a  \nb'],
  ['inline code', 'a `b` c'],
] as const;

const variants = [
  ['a setext heading', 'Title\n=====\n\nSub\n---\n'],
  ['closing hashes', '# Title #\n'],
  ['CRLF line endings', '# Title\r\n\r\nText\r\nmore\r\n'],
  ['a bare CR', 'a\rb\n'],
  ['leading and extra blank lines', '\n\n# Title\n\n\n\nText\n\n\n'],
  ['no final newline', 'Text'],
  ['an indented heading', '   # Title\n'],
  ['an indented list', '  - a\n\n      b\n'],
  ['an indented table', '  | a |\n  | - |\n  | 1 |\n'],
  ['a character reference', '&copy; 2026 &amp; more\n'],
  ['a BOM', '\uFEFF# Title\n'],
  ['a BOM before a table', '\uFEFF| a |\n| - |\n'],
  ['an empty body', ''],
  ['blank lines only', '\n\n  \n'],
  ['a container past column 100', `${' '.repeat(0)}${'- '.repeat(51)}x\n`],
  ['a tree deeper than 100 levels', `${'*'.repeat(120)}a${'*'.repeat(120)}\n`],
  ['more than 10 fence lines', `${':::a\n'.repeat(11)}x\n`],
  ['a heading then a lazy paragraph line', '# Title\nText\n'],
  ['a paragraph then a list', 'Text\n- a\n'],
  ['an unclosed fence', 'Text\n\n```\ncode'],
  ['adjacent lists with two markers', '- a\n* b\n'],
] as const;

describe('markdown in and out', () => {
  it.each(canonical.map((body) => [JSON.stringify(body).slice(0, 48), body] as const))(
    'writes canonical %s back byte for byte',
    (_name, body) => {
      expect(roundTrip(body)).toBe(body);
    },
  );

  it.each(unmodelled)('loads %s as one raw block holding its source', (_name, body) => {
    const blocks = snapshot(loaded(body));
    const raw = blocks.filter((block) => block.type === 'raw').map((block) => block.text);
    expect(raw.join('\n\n')).toBe(body);
    expect(output(loaded(body))).toBe(body);
  });

  it('models a plain paragraph and a heading as text', () => {
    expect(shape(snapshot(loaded('# A *b*?\n\nPlain 10:30 \\* text\n## x')))).toEqual([
      { type: 'raw', text: '# A *b*?' },
      { type: 'paragraph', text: 'Plain 10:30 * text' },
      { type: 'heading', level: 2, text: 'x' },
    ]);
  });

  it.each([
    ['a typed colon', 'Meet at 10:30, Status:done', 'Meet at 10:30, Status:done\n'],
    ['a typed leaf directive', '::metric', ':\\:metric\n'],
    ['a typed container fence', ':::note', '::\\:note\n'],
    ['a typed star', '*not emphasis*', '\\*not emphasis\\*\n'],
    ['a typed heading marker', '# not a heading', '\\# not a heading\n'],
  ])('saves %s as text that reads back the same', (_name, text, saved) => {
    const doc = docOf([{ id: 'p', type: 'paragraph', text }]);
    expect(output(doc)).toBe(saved);
    expect(shape(snapshot(loaded(saved)))).toEqual([{ type: 'paragraph', text }]);
  });

  it('writes nothing for empty paragraphs and one empty paragraph for an empty body', () => {
    const doc = docOf([
      { id: 'a', type: 'paragraph', text: '' },
      { id: 'b', type: 'paragraph', text: 'x' },
      { id: 'c', type: 'raw', text: '' },
      { id: 'd', type: 'paragraph', text: '' },
    ]);
    expect(output(doc)).toBe('x\n');
    expect(output(docOf([{ id: 'a', type: 'paragraph', text: '' }]))).toBe('');
    expect(shape(snapshot(loaded('')))).toEqual([{ type: 'paragraph', text: '' }]);
  });

  it('gives every loaded block its own id', () => {
    const doc = loaded('# a\n\nb\n\n- c\n');
    expect(new Set(doc.ids).size).toBe(3);
    expect(doc.ids.every((id) => id.length > 0)).toBe(true);
  });

  it.each([
    ['an empty id for a block', '# a\n\nb\n', () => ''],
    ['the same id for two blocks', '# a\n\nb\n', () => 'same'],
    ['an empty id for a guarded body', `${'- '.repeat(51)}x\n`, () => ''],
    ['an empty id for an empty body', '', () => ''],
  ])('refuses to load when newId returns %s', (_name, body, ids) => {
    expect(() => load(body, ids)).toThrow(RangeError);
  });

  it.each([
    ['a NUL character', 'a\0b\n'],
    ['a lone surrogate', '| a |\n| - |\n| \ud800 |\n'],
  ])('refuses to load a body with %s', (_name, body) => {
    expect(() => load(body, newId)).toThrow(RangeError);
  });

  it('loads a guarded body as one raw block holding the whole source', () => {
    const body = `${'- '.repeat(51)}x\n\nmore`;
    expect(shape(snapshot(loaded(body)))).toEqual([{ type: 'raw', text: body }]);
    expect(roundTrip(body)).toBe(body);
  });
});

describe('text blocks read back exactly', () => {
  it.each([
    ['a backslash before a blank line', 'x\\\n\n- y'],
    ['a backslash before a final line ending', 'a\\\n'],
    ['a line that would underline the one before', '\n -\n-'],
    ['only line endings', '\n\n'],
    ['a backslash and a hash on two lines', '\\\n\\\n\n#'],
  ])('writes %s so it reads back as typed', (_name, text) => {
    for (const kind of kinds.filter((each) => each.type !== 'raw')) {
      const doc = docOf([{ ...kind, id: 'p', text }]);
      const saved = output(doc);
      expect(shape(snapshot(loaded(saved))), JSON.stringify(kind)).toEqual(shape(snapshot(doc)));
    }
  });

  it.each(seeds)('for random text in every block type (seed %i)', (seed) => {
    const random = seeded(seed);
    for (let run = 0; run < 100; run += 1) {
      const kind = random.pick(kinds.filter((each) => each.type !== 'raw'));
      const text = randomText(random, 8);
      const doc = docOf([{ ...kind, id: 'p', text }]);
      const where = `seed ${seed} run ${run} ${JSON.stringify({ kind, text })}`;
      expect(shape(snapshot(loaded(output(doc)))), where).toEqual(shape(snapshot(doc)));
    }
  });
});

describe('a load and save never changes the page', () => {
  it.each([
    ...canonical.map((body) => [JSON.stringify(body).slice(0, 40), body] as const),
    ...variants,
  ])('%s', (_name, body) => {
    const saved = roundTrip(body);
    const lf = body.replace(/\r\n?/g, '\n');
    expect(mdast(saved)).toEqual(mdast(lf));
    expect(render(saved)).toBe(render(lf));
    expect(roundTrip(saved)).toBe(saved);
  });
});

const fragments = [
  '# Title',
  'Title\n===',
  'Plain text with 10:30 and Status:done',
  'Some *em* and **strong**',
  'a [link](https://example.test)',
  '<https://example.test>',
  '![alt](https://example.test/a.png)',
  '- one\n- two',
  '* star\n* list',
  '1. first\n2. second',
  '- [ ] task',
  '> quote\n> more',
  '```js\ncode\n```',
  '    indented',
  '<div>\nhtml\n</div>',
  '<!-- note -->',
  '| a | b |\n| - | - |\n| 1 | 2 |',
  'Note[^1]',
  '[^1]: The note.',
  '[ref]: https://example.test',
  'see [ref]',
  '---',
  '::metric{value="3"}',
  ':::callout\ninside\n:::',
  ':::unknown{a="1"}\n- item\n:::',
  'line one\nline two',
  'hard  \nbreak',
  'x \\* y',
  '&copy; 2026',
  '~~gone~~',
  '\t- tab list',
  '  - indented list\n\n      more',
  ' # spaced heading',
  '- a\n\n      code in item',
  ':\\:typed',
  '10. step',
  '    <img src=x onerror=alert(1)>',
  '    [x]: https://evil.test',
];

function randomBody(random: Random): string {
  const parts = Array.from({ length: 1 + random.int(6) }, () => random.pick(fragments));
  const glue = () => random.pick(['\n', '\n\n', '\n\n', '\n\n\n']);
  return parts.reduce((body, part) => `${body}${glue()}${part}`, random.pick(['', '\n']));
}

describe('random bodies', () => {
  it.each(seeds)('load and save without a change to the page (seed %i)', (seed) => {
    const random = seeded(seed);
    for (let run = 0; run < 50; run += 1) {
      const body = randomBody(random);
      const where = `seed ${seed} run ${run} ${JSON.stringify(body)}`;
      const saved = roundTrip(body);
      expect(mdast(saved), where).toEqual(mdast(body));
      expect(render(saved), where).toBe(render(body));
      expect(roundTrip(saved), where).toBe(saved);
    }
  });

  it.each(seeds)('save an edit only when it reloads to the model (seed %i)', (seed) => {
    const random = seeded(seed);
    const modelled = kinds.filter((kind) => kind.type !== 'raw');
    let next = 0;
    for (let run = 0; run < 50; run += 1) {
      let doc = loaded(randomBody(random));
      for (let step = random.int(4); step >= 0; step -= 1) {
        doc = apply(
          doc,
          randomOp(doc, random, () => `n${next++}`, modelled),
        ).doc;
      }
      const result = save(doc);
      if (!result.ok) continue;
      const where = `seed ${seed} run ${run} ${JSON.stringify(result.markdown)}`;
      expectReadsAs(result.markdown, doc, where);
    }
  });
});

const live = ['html', 'definition', 'link', 'list'];

function liveCounts(node: Nodes, counts = new Map<string, number>()): Map<string, number> {
  if (live.includes(node.type)) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  if ('children' in node) for (const child of node.children) liveCounts(child, counts);
  return counts;
}

function typesOf(doc: Doc): string[] {
  return snapshot(doc).flatMap((block) => {
    if (block.type === 'raw') return parseMarkdown(block.text).children.map((node) => node.type);
    return block.type === 'paragraph' && block.text === '' ? [] : [block.type];
  });
}

function expectReadsAs(markdown: string, doc: Doc, where: string) {
  const tree = parseMarkdown(markdown);
  expect(
    tree.children.map((node) => node.type),
    where,
  ).toEqual(typesOf(doc));
  expect(keptInOrder(textOnly(loaded(markdown)), textOnly(doc)), where).toEqual(textOnly(doc));
  const model = new Map<string, number>();
  for (const block of snapshot(doc).filter((each) => each.type === 'raw')) {
    liveCounts(parseMarkdown(block.text), model);
  }
  for (const [type, count] of liveCounts(tree)) {
    expect(count, `${where} ${type}`).toBeLessThanOrEqual(model.get(type) ?? 0);
  }
}

function textOnly(doc: Doc) {
  return shape(
    snapshot(doc).filter(
      (block) => block.type !== 'raw' && (block.type !== 'paragraph' || block.text !== ''),
    ),
  );
}

function keptInOrder<T>(found: readonly T[], wanted: readonly T[]): T[] {
  const kept: T[] = [];
  for (const each of found) {
    if (
      kept.length < wanted.length &&
      JSON.stringify(each) === JSON.stringify(wanted[kept.length])
    ) {
      kept.push(each);
    }
  }
  return kept;
}

function normalized(body: string): string {
  return body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function fences(markdown: string): number {
  return markdown.split(':::').length - 1;
}

const bom = '\uFEFF';

const unedited = [
  ['a BOM after a blank line before a container', `\n${bom}:::callout\n*inside* the page\n`],
  [
    'a BOM after a blank line before a definition',
    `\n${bom}[x]: javascript:alert(1)\n*y* see [x]\n`,
  ],
  ['a BOM after a blank line before HTML', `\n${bom}<img src=x onerror=alert(1)>\n*x*\n`],
  ['a BOM after a blank line before a heading', `\n${bom}# Big *heading*\n`],
  ['a BOM after a blank line before a fence', `\n${bom}\`\`\`\n*x*\n\nlater\n\n## later\n`],
  ['a BOM after a blank line before a comment', `\n${bom}<!-- *x*\n\nlater paragraph\n`],
  ['a BOM after a blank line before plain text', `\n${bom}:::callout\nplain\n`],
  ['a decoded carriage return', 'a&#13;b\n\nnext\n'],
  ['escaped dashes at the length limit', '\\-\n'.repeat(6666)],
  ['colons written as references', 'a&#x3a;&#x3a;&#x3a;b\n'.repeat(11)],
  ['headings on consecutive lines', '# a\n## b\nText\n- c\n'],
  ['three blank lines and no final line ending', 'a\n\n\n\nb'],
  ['an unclosed fence at the end', 'Intro\n\n```\ncode\n'],
] as const;

describe('a load and save with no edit gives the body back', () => {
  it.each([
    ...unedited,
    ...canonical.map((body) => [JSON.stringify(body).slice(0, 40), body] as const),
    ...variants.filter(([name]) => name !== 'blank lines only'),
  ])('%s', (_name, body) => {
    const doc = loaded(body);
    expect(docProblems(doc)).toEqual([]);
    const saved = output(doc);
    expect(saved).toBe(normalized(body));
    expect(render(saved)).toBe(render(normalized(body)));
  });

  it('reads a second BOM as text, as the renderer does', () => {
    const body = `${bom}${bom}# T\n`;
    expect(shape(snapshot(loaded(body)))).toEqual([{ type: 'paragraph', text: `${bom}# T` }]);
    expect(render(output(loaded(body)))).toBe(render(body));
  });

  it('loads a character reference that decodes to a carriage return as raw source', () => {
    const doc = loaded('a&#13;b\n');
    expect(shape(snapshot(doc))).toEqual([{ type: 'raw', text: 'a&#13;b' }]);
    const id = doc.ids[0] as string;
    expect(output(apply(doc, { type: 'insertText', id, offset: 0, text: 'x' }).doc)).toBe(
      'xa&#13;b\n',
    );
  });

  it.each(seeds)('for random bodies (seed %i)', (seed) => {
    const random = seeded(seed);
    for (let run = 0; run < 50; run += 1) {
      const body = randomBody(random);
      expect(roundTrip(body), `seed ${seed} run ${run} ${JSON.stringify(body)}`).toBe(body);
    }
  });
});

function typedAfter(body: string, text: string) {
  const doc = loaded(body);
  const last = doc.ids.at(-1) as string;
  const end = doc.blocks.get(last)?.text.length ?? 0;
  const split = apply(doc, {
    type: 'splitBlock',
    id: last,
    offset: end,
    newId: 'typed',
    kind: { type: 'paragraph' },
  }).doc;
  return apply(split, { type: 'insertText', id: 'typed', offset: 0, text }).doc;
}

function emptied(body: string, index: number): Doc {
  const doc = loaded(body);
  const id = doc.ids[index] as string;
  const to = doc.blocks.get(id)?.text.length ?? 0;
  return apply(doc, { type: 'deleteText', id, from: 0, to }).doc;
}

function indented(body: string, index: number): Doc {
  const doc = loaded(body);
  return apply(doc, { type: 'insertText', id: doc.ids[index] as string, offset: 0, text: '  ' })
    .doc;
}

describe('an edit changes only the block it touches', () => {
  it('refuses to save a list that would take in the code below an emptied paragraph', () => {
    const doc = emptied('- step one\n\nNote\n\n    <img src=x onerror=alert(1)>\n', 1);
    const before = snapshot(doc);
    expect(save(doc)).toEqual({ ok: false, reason: 'misread', blockId: doc.ids[2] });
    expect(snapshot(doc)).toEqual(before);
  });

  it.each([
    [
      'a list over indented code',
      emptied('- step one\n\nNote\n\n    <img src=x onerror=alert(1)>\n', 1),
    ],
    ['a "10." list', emptied('10. step\n\nNote\n\n    *x* [y](https://evil.test)\n', 1)],
    [
      'a footnote definition over a script',
      emptied('[^1]: note\n\nNote\n\n    <script>alert(1)</script>\n', 1),
    ],
    ['an indented definition', emptied('- item\n\nNote\n\n    [x]: https://evil.test\n', 1)],
    ['an open fence before a new paragraph', typedAfter('Intro\n\n```\ncode\n', 'typed')],
    ['a fence moved under a list item', indented('- item\n\n```\ncode\n```\n', 1)],
    [
      'a list item emptied below indented code',
      docOf([
        { id: 'code', type: 'raw', text: '    code' },
        { id: 'item', type: 'raw', text: '-' },
      ]),
    ],
  ])('refuses or keeps every block after %s', (name, doc) => {
    const before = snapshot(doc);
    const result = save(doc);
    if (result.ok) expectReadsAs(result.markdown, doc, name);
    else expect(result.reason).toBe('misread');
    expect(snapshot(doc)).toEqual(before);
  });

  it.each([
    ['a heading above a paragraph', 'para one\n\n# H\npara two\n', 1],
    ['a thematic break above a paragraph', 'para one\n\n***\npara two\n', 1],
    [
      'a heading below a paragraph',
      '# Acme\nLead engineer\n\n## Fleet routing\nCut delivery time\n',
      2,
    ],
  ])('saves a body once %s is deleted', (name, body, index) => {
    const emptiedDoc = emptied(body, index);
    const doc = apply(emptiedDoc, { type: 'mergeBlocks', id: emptiedDoc.ids[index] as string }).doc;
    const result = save(doc);
    expect(result, name).toEqual({ ok: true, markdown: expect.any(String) });
    if (result.ok) expectReadsAs(result.markdown, doc, name);
  });

  it.each([
    ['an unclosed pre', 'Intro\n\n<pre>\nlog line\n'],
    ['an unclosed comment', 'Intro\n\n<!-- draft note\n'],
    ['an unclosed script', 'Intro\n\n<SCRIPT>\nx\n'],
    ['an unclosed processing instruction', 'Intro\n\n<?php\nx\n'],
    ['an unclosed CDATA section', 'Intro\n\n<![CDATA[\nx\n'],
    ['an unclosed declaration', 'Intro\n\n<!DOCTYPE\nx\n'],
    ['an unclosed backtick fence', 'Intro\n\n```\ncode\n'],
    ['an unclosed tilde fence', 'Intro\n\n~~~~ js\ncode\n~~~\nmore'],
    ['an unclosed container', 'Intro\n\n::::callout\ninside\n:::'],
    ['a fence open inside an open container', 'Intro\n\n:::callout\n```\ncode\n'],
  ])('refuses a paragraph typed after %s, naming it', (_name, body) => {
    const doc = typedAfter(body, '<img src=x onerror=alert(1)>');
    expect(save(doc)).toEqual({ ok: false, reason: 'misread', blockId: 'typed' });
  });

  it('refuses an edit that makes the body trip a parser limit', () => {
    const doc = docOf([
      { id: 'q', type: 'raw', text: `${'> '.repeat(150)}a` },
      { id: 'p', type: 'paragraph', text: 'edited' },
    ]);
    expect(save(doc)).toEqual({ ok: false, reason: 'guard' });
  });

  it('writes the loaded bytes again once an edit or a split is undone', () => {
    const body = 'Title\n=====\n\ntext\n';
    const doc = loaded(body);
    const id = doc.ids[0] as string;
    for (const op of [
      { type: 'insertText', id, offset: 5, text: 'x' },
      { type: 'splitBlock', id, offset: 2, newId: 'n', kind: { type: 'paragraph' } },
    ] satisfies Op[]) {
      const edit = apply(doc, op);
      expect(output(apply(edit.doc, edit.inverse).doc), op.type).toBe(body);
    }
  });

  it('rewrites an unedited block whose source would read differently next to new blocks', () => {
    const plain = loaded('[x] and [^1]\n');
    const doc = docOf(
      [
        { id: 'd', type: 'raw', text: '[x]: https://example.test\n\n[^1]: note' },
        ...snapshot(plain),
      ],
      plain.sources,
    );
    const saved = output(doc);
    expect(textOnly(loaded(saved))).toEqual(textOnly(doc));
    expect(render(saved)).not.toContain('<a');
  });

  it('finds a heading whose position starts at the definition before it', () => {
    const doc = loaded('[x]: https://example.test\nx\n===\n\nPlain\n');
    const id = doc.ids[2] as string;
    const edited = apply(doc, { type: 'insertText', id, offset: 0, text: 'y' }).doc;
    expect(output(edited)).toBe('[x]: https://example.test\nx\n===\n\nyPlain\n');
  });

  it('keeps plain text plain next to a definition it would otherwise use', () => {
    const doc = docOf([
      { id: 'd', type: 'raw', text: '[x]: https://example.test' },
      { id: 'p', type: 'paragraph', text: '[y][x] and [x]' },
    ]);
    const saved = output(doc);
    expect(textOnly(loaded(saved))).toEqual(textOnly(doc));
    expect(render(saved)).not.toContain('<a');
  });

  it('writes a block that starts with a BOM so it keeps its meaning at the start', () => {
    const raw = docOf([{ id: 'r', type: 'raw', text: `${bom}[x]: javascript:alert(1)\n*y* [x]` }]);
    expect(render(output(raw))).not.toContain('<a');
    const text = docOf([{ id: 'p', type: 'paragraph', text: `${bom}# h` }]);
    expect(textOnly(loaded(output(text)))).toEqual(textOnly(text));
  });

  it('keeps an edited body within the limits the loaded body met', () => {
    const body = '\\-\n'.repeat(6666);
    const doc = loaded(body);
    const id = doc.ids[0] as string;
    const edited = apply(doc, { type: 'insertText', id, offset: 0, text: 'x' }).doc;
    const saved = output(edited);
    expect(saved.length).toBeLessThanOrEqual(body.length + 1);
    expect(textOnly(loaded(saved))).toEqual(textOnly(edited));
    for (const text of ['a:::b ::: c::::\n:::d', '::::::', ':'.repeat(6666)]) {
      const colons = docOf([{ id: 'p', type: 'paragraph', text }]);
      expect(fences(output(colons)), text.slice(0, 12)).toBe(0);
      expect(textOnly(loaded(output(colons)))).toEqual(textOnly(colons));
    }
  });

  it('keeps the source and spacing of every block the edit does not touch', () => {
    const body = '# a\n## b\nText one\n\n\n| t |\n| - |\nlast *x*';
    const doc = loaded(body);
    const id = doc.ids[2] as string;
    const saved = output(apply(doc, { type: 'insertText', id, offset: 0, text: 'x' }).doc);
    expect(saved).toBe('# a\n## b\n\nxText one\n\n\n| t |\n| - |\nlast *x*');
  });

  it.each([...'\x01\x08\t\x0b\x0c\x1f !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~\x7f\u00a0\u2028\u3000'])(
    'reads %j back at the edges of every line',
    (char) => {
      for (const kind of kinds.filter((each) => each.type !== 'raw')) {
        for (const text of [
          char,
          `${char}x`,
          `x${char}`,
          `x\n${char}`,
          `${char}\nx`,
          `x${char}\n`,
          `${char}${char}${char}`,
        ]) {
          const doc = docOf([{ ...kind, id: 'p', text }]);
          expect(textOnly(loaded(output(doc))), JSON.stringify({ kind, text })).toEqual(
            textOnly(doc),
          );
        }
      }
    },
  );
});
