import type { Nodes, Root, RootContent } from 'mdast';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { containerDirective, leafDirective } from '../src/core/directive.ts';
import { load, save } from '../src/core/markdown.ts';
import { docOf, hasKeys, noProps, schema } from '../src/core/model.ts';
import { apply } from '../src/core/ops.ts';
import { registryOf } from '../src/core/registry.ts';
import type { Block, Component, Doc, NoProps, Op } from '../src/core/types.ts';
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

const raw = (text: string) => ({ type: 'raw', props: {}, fields: { text } });

const paragraph = { type: 'paragraph', props: {} };

const para = (text: string) => ({ ...paragraph, fields: { text } });

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
    const texts = blocks.filter((block) => block.type === 'raw').map((block) => block.fields.text);
    expect(texts.join('\n\n')).toBe(body);
    expect(output(loaded(body))).toBe(body);
  });

  it('models a plain paragraph and a heading as text', () => {
    expect(shape(snapshot(loaded('# A *b*?\n\nPlain 10:30 \\* text\n## x')))).toEqual([
      raw('# A *b*?'),
      para('Plain 10:30 * text'),
      { type: 'heading', props: { level: 2 }, fields: { text: 'x' } },
    ]);
  });

  it.each([
    ['a typed colon', 'Meet at 10:30, Status:done', 'Meet at 10:30, Status:done\n'],
    ['a typed leaf directive', '::metric', ':\\:metric\n'],
    ['a typed container fence', ':::note', '::\\:note\n'],
    ['a typed star', '*not emphasis*', '\\*not emphasis\\*\n'],
    ['a typed heading marker', '# not a heading', '\\# not a heading\n'],
  ])('saves %s as text that reads back the same', (_name, text, saved) => {
    const doc = docOf([{ id: 'p', ...para(text) }]);
    expect(output(doc)).toBe(saved);
    expect(shape(snapshot(loaded(saved)))).toEqual([para(text)]);
  });

  it('writes nothing for empty paragraphs and one empty paragraph for an empty body', () => {
    const doc = docOf([
      { id: 'a', ...para('') },
      { id: 'b', ...para('x') },
      { id: 'c', ...raw('') },
      { id: 'd', ...para('') },
    ]);
    expect(output(doc)).toBe('x\n');
    expect(output(docOf([{ id: 'a', ...para('') }]))).toBe('');
    expect(shape(snapshot(loaded('')))).toEqual([para('')]);
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
    expect(shape(snapshot(loaded(body)))).toEqual([raw(body)]);
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
      const doc = docOf([{ ...kind, id: 'p', fields: { text } }]);
      const saved = output(doc);
      expect(shape(snapshot(loaded(saved))), JSON.stringify(kind)).toEqual(shape(snapshot(doc)));
    }
  });

  it.each(seeds)('for random text in every block type (seed %i)', (seed) => {
    const random = seeded(seed);
    for (let run = 0; run < 100; run += 1) {
      const kind = random.pick(kinds.filter((each) => each.type !== 'raw'));
      const text = randomText(random, 8);
      const doc = docOf([{ ...kind, id: 'p', fields: { text } }]);
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
      const body = randomBody(random);
      let doc = loaded(body);
      const nodes = loadedNodes(body, doc);
      for (let step = random.int(4); step >= 0; step -= 1) {
        doc = apply(
          doc,
          randomOp(doc, random, () => `n${next++}`, modelled, true),
        ).doc;
      }
      const result = save(doc);
      if (!result.ok) continue;
      const where = `seed ${seed} run ${run} ${JSON.stringify(result.markdown)}`;
      expectReadsAs(result.markdown, doc, where, nodes);
    }
  });
});

const live = ['html', 'definition', 'link', 'list'];

function liveCounts(node: Nodes, counts = new Map<string, number>()): Map<string, number> {
  if (live.includes(node.type)) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  if ('children' in node) for (const child of node.children) liveCounts(child, counts);
  return counts;
}

function loadedNodes(body: string, doc: Doc): Map<Block, RootContent> {
  const nodes = parseMarkdown(body).children;
  return new Map(
    snapshot(doc).flatMap((block, index): [Block, RootContent][] => {
      const node = nodes[index];
      return block.type === 'raw' && node !== undefined ? [[block, node]] : [];
    }),
  );
}

function rawNodes(block: Block, nodes: ReadonlyMap<Block, RootContent>): readonly RootContent[] {
  const node = nodes.get(block);
  return node === undefined ? parseMarkdown(block.fields.text).children : [node];
}

function typesOf(doc: Doc, nodes: ReadonlyMap<Block, RootContent>): string[] {
  return snapshot(doc).flatMap((block) => {
    if (block.type === 'raw') return rawNodes(block, nodes).map((node) => node.type);
    return block.type === 'paragraph' && block.fields.text === '' ? [] : [block.type];
  });
}

function expectReadsAs(
  markdown: string,
  doc: Doc,
  where: string,
  nodes: ReadonlyMap<Block, RootContent> = new Map(),
) {
  const tree = parseMarkdown(markdown);
  expect(
    tree.children.map((node) => node.type),
    where,
  ).toEqual(typesOf(doc, nodes));
  expect(keptInOrder(textOnly(loaded(markdown)), textOnly(doc)), where).toEqual(textOnly(doc));
  const model = new Map<string, number>();
  for (const block of snapshot(doc).filter((each) => each.type === 'raw')) {
    for (const node of rawNodes(block, nodes)) liveCounts(node, model);
  }
  for (const [type, count] of liveCounts(tree)) {
    expect(count, `${where} ${type}`).toBeLessThanOrEqual(model.get(type) ?? 0);
  }
}

function textOnly(doc: Doc) {
  return shape(
    snapshot(doc).filter(
      (block) => block.type !== 'raw' && (block.type !== 'paragraph' || block.fields.text !== ''),
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
    expect(shape(snapshot(loaded(body)))).toEqual([para(`${bom}# T`)]);
    expect(render(output(loaded(body)))).toBe(render(body));
  });

  it('loads a character reference that decodes to a carriage return as raw source', () => {
    const doc = loaded('a&#13;b\n');
    expect(shape(snapshot(doc))).toEqual([raw('a&#13;b')]);
    const id = doc.ids[0] as string;
    expect(output(apply(doc, typed(id, 0, 'x')).doc)).toBe('xa&#13;b\n');
  });

  it.each(seeds)('for random bodies (seed %i)', (seed) => {
    const random = seeded(seed);
    for (let run = 0; run < 50; run += 1) {
      const body = randomBody(random);
      expect(roundTrip(body), `seed ${seed} run ${run} ${JSON.stringify(body)}`).toBe(body);
    }
  });
});

function typed(blockId: string, offset: number, text: string): Op {
  return { kind: 'insertText', blockId, field: 'text', offset, text };
}

function typedAfter(body: string, text: string) {
  const doc = loaded(body);
  const last = doc.ids.at(-1) as string;
  const end = doc.blocks.get(last)?.fields.text.length ?? 0;
  const split = apply(doc, {
    kind: 'splitBlock',
    blockId: last,
    field: 'text',
    offset: end,
    newId: 'typed',
    ...paragraph,
  }).doc;
  return apply(split, typed('typed', 0, text)).doc;
}

function emptied(body: string, index: number): Doc {
  const doc = loaded(body);
  const id = doc.ids[index] as string;
  const to = doc.blocks.get(id)?.fields.text.length ?? 0;
  return apply(doc, { kind: 'deleteText', blockId: id, field: 'text', from: 0, to }).doc;
}

function indented(body: string, index: number): Doc {
  const doc = loaded(body);
  return apply(doc, typed(doc.ids[index] as string, 0, '  ')).doc;
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
        { id: 'code', ...raw('    code') },
        { id: 'item', ...raw('-') },
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
    const blockId = emptiedDoc.ids[index] as string;
    const doc = apply(emptiedDoc, { kind: 'mergeBlocks', blockId }).doc;
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
      { id: 'q', ...raw(`${'> '.repeat(150)}a`) },
      { id: 'p', ...para('edited') },
    ]);
    expect(save(doc)).toEqual({ ok: false, reason: 'guard' });
  });

  it('writes the loaded bytes again once an edit, a split or a level change is undone', () => {
    const body = 'Title\n=====\n\ntext\n';
    const doc = loaded(body);
    const id = doc.ids[0] as string;
    const ops: Op[] = [
      typed(id, 5, 'x'),
      { kind: 'splitBlock', blockId: id, field: 'text', offset: 2, newId: 'n', ...paragraph },
      { kind: 'setProps', blockId: id, props: { level: 2 } },
    ];
    for (const op of ops) {
      const edit = apply(doc, op);
      expect(output(edit.doc), op.kind).not.toBe(body);
      expect(output(apply(edit.doc, edit.inverse).doc), op.kind).toBe(body);
    }
  });

  it('rewrites an unedited block whose source would read differently next to new blocks', () => {
    const plain = loaded('[x] and [^1]\n');
    const doc = docOf(
      [{ id: 'd', ...raw('[x]: https://example.test\n\n[^1]: note') }, ...snapshot(plain)],
      plain.sources,
    );
    const saved = output(doc);
    expect(textOnly(loaded(saved))).toEqual(textOnly(doc));
    expect(render(saved)).not.toContain('<a');
  });

  it('finds a heading whose position starts at the definition before it', () => {
    const doc = loaded('[x]: https://example.test\nx\n===\n\nPlain\n');
    const id = doc.ids[2] as string;
    const edited = apply(doc, typed(id, 0, 'y')).doc;
    expect(output(edited)).toBe('[x]: https://example.test\nx\n===\n\nyPlain\n');
  });

  it('keeps plain text plain next to a definition it would otherwise use', () => {
    const doc = docOf([
      { id: 'd', ...raw('[x]: https://example.test') },
      { id: 'p', ...para('[y][x] and [x]') },
    ]);
    const saved = output(doc);
    expect(textOnly(loaded(saved))).toEqual(textOnly(doc));
    expect(render(saved)).not.toContain('<a');
  });

  it('writes a block that starts with a BOM so it keeps its meaning at the start', () => {
    const source = docOf([{ id: 'r', ...raw(`${bom}[x]: javascript:alert(1)\n*y* [x]`) }]);
    expect(render(output(source))).not.toContain('<a');
    const text = docOf([{ id: 'p', ...para(`${bom}# h`) }]);
    expect(textOnly(loaded(output(text)))).toEqual(textOnly(text));
  });

  it('keeps an edited body within the limits the loaded body met', () => {
    const body = '\\-\n'.repeat(6666);
    const doc = loaded(body);
    const id = doc.ids[0] as string;
    const edited = apply(doc, typed(id, 0, 'x')).doc;
    const saved = output(edited);
    expect(saved.length).toBeLessThanOrEqual(body.length + 1);
    expect(textOnly(loaded(saved))).toEqual(textOnly(edited));
    for (const text of ['a:::b ::: c::::\n:::d', '::::::', ':'.repeat(6666)]) {
      const colons = docOf([{ id: 'p', ...para(text) }]);
      expect(fences(output(colons)), text.slice(0, 12)).toBe(0);
      expect(textOnly(loaded(output(colons)))).toEqual(textOnly(colons));
    }
  });

  it('keeps the source and spacing of every block the edit does not touch', () => {
    const body = '# a\n## b\nText one\n\n\n| t |\n| - |\nlast *x*';
    const doc = loaded(body);
    const id = doc.ids[2] as string;
    const saved = output(apply(doc, typed(id, 0, 'x')).doc);
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
          const doc = docOf([{ ...kind, id: 'p', fields: { text } }]);
          expect(textOnly(loaded(output(doc))), JSON.stringify({ kind, text })).toEqual(
            textOnly(doc),
          );
        }
      }
    },
  );
});

describe('directive blocks', () => {
  const toneProps = schema(
    (value): value is { readonly tone: string } =>
      hasKeys(value, ['tone']) && ['info', 'warning'].includes(Reflect.get(value, 'tone')),
  );
  const callout: Component<'callout', { readonly tone: string }, 'title', 'body'> = {
    name: 'callout',
    props: toneProps,
    fields: ['title'],
    slots: ['body'],
    markdown: containerDirective({
      name: 'callout',
      props: toneProps,
      keys: ['tone'],
      attributes: [],
      label: 'title',
      slot: 'body',
    }),
  };
  const metric: Component<'metric', NoProps, 'value' | 'label'> = {
    name: 'metric',
    props: noProps,
    fields: ['value', 'label'],
    markdown: leafDirective({
      name: 'metric',
      props: noProps,
      keys: [],
      attributes: ['value', 'label'],
    }),
  };
  const stat: Component<'stat', NoProps, 'text'> = {
    name: 'stat',
    props: noProps,
    fields: ['text'],
    markdown: leafDirective({
      name: 'stat',
      props: noProps,
      keys: [],
      attributes: [],
      label: 'text',
    }),
  };
  const registry = registryOf([callout, metric, stat]);
  const loadedWith = (markdown: string) => load(markdown, newId, registry);
  function savedWith(doc: Doc): string {
    const result = save(doc, registry);
    if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
    return result.markdown;
  }
  function tree(doc: Doc) {
    const of = (id: string): object => {
      const { id: _id, slots, ...rest } = doc.blocks.get(id) as Block;
      return slots === undefined
        ? rest
        : {
            ...rest,
            slots: Object.fromEntries(Object.entries(slots).map(([n, ids]) => [n, ids.map(of)])),
          };
    };
    return doc.ids.map(of);
  }
  const child = (doc: Doc, index: number) =>
    doc.blocks.get(doc.ids[0] as string)?.slots?.body?.[index] as string;
  const page =
    ':::callout{tone="info"}\nInside the callout\n\n# A heading\n\n::metric{value="42%" label="Faster builds"}\n:::\n\nAfter.\n';

  it('loads a container with its children in its slot, one level deep', () => {
    const doc = loadedWith(page);
    expect(tree(doc)).toEqual([
      {
        type: 'callout',
        props: { tone: 'info' },
        fields: { title: '' },
        slots: {
          body: [
            para('Inside the callout'),
            { type: 'heading', props: { level: 1 }, fields: { text: 'A heading' } },
            { type: 'metric', props: {}, fields: { value: '42%', label: 'Faster builds' } },
          ],
        },
      },
      para('After.'),
    ]);
    expect(doc.blocks.size).toBe(5);
  });

  it.each([
    page,
    '\n:::callout[Read this]{tone="warning"}\n\n\nFirst\n:::\n',
    ':::callout[Plain title]{tone="info"}\n:::',
    ':::callout{tone="info"}\n  Indented   text\n:::\n\n::metric{value=\'single\'}\n',
  ])('saves an untouched container byte for byte (%j)', (body) => {
    expect(savedWith(loadedWith(body))).toBe(body);
  });

  it('saves an edited container so that it reloads to the same model', () => {
    const doc = loadedWith(page);
    const edits: Op[] = [
      { kind: 'insertText', blockId: child(doc, 0), field: 'text', offset: 0, text: '- :::\n' },
      { kind: 'deleteText', blockId: child(doc, 1), field: 'text', from: 0, to: 2 },
      { kind: 'setProps', blockId: doc.ids[0] as string, props: { tone: 'warning' } },
      {
        kind: 'insertText',
        blockId: doc.ids[0] as string,
        field: 'title',
        offset: 0,
        text: 'Note',
      },
    ];
    const edited = edits.reduce((each, op) => apply(each, op, registry).doc, doc);
    const saved = savedWith(edited);
    expect(saved).toBe(
      ':::callout[Note]{tone="warning"}\n\\- ::\\:\nInside the callout\n\n# heading\n\n::metric{value="42%" label="Faster builds"}\n:::\n\nAfter.\n',
    );
    expect(tree(loadedWith(saved))).toEqual(tree(edited));
  });

  it.each([
    '"double" \'single\' } ] javascript:alert(1)',
    '<img src=x onerror=alert(1)>',
    '\\" ::: \\',
    '{#id .class key=value}',
    '&quot; &amp;',
    '&#x22;',
    'R&D',
    '*em*',
    '**b**',
    '_x_',
    '`c`',
    '~~s~~',
    '<http://a.test>',
    '\\*',
  ])('round-trips the text %j in an attribute and in a leaf and a container label', (text) => {
    for (const [body, field] of [
      ['::metric{value="1"}\n', 'label'],
      ['::stat[x]\n', 'text'],
      [':::callout{tone="info"}\nText\n:::\n', 'title'],
    ] as const) {
      const doc = loadedWith(body);
      const op: Op = { kind: 'insertText', blockId: doc.ids[0] as string, field, offset: 0, text };
      const edited = apply(doc, op, registry).doc;
      expect(tree(loadedWith(savedWith(edited)))).toEqual(tree(edited));
    }
  });

  it.each([
    ['a child no slot-less component reads', ':::callout{tone="info"}\nText\n\n- a list\n:::'],
    [
      'a container inside a container',
      '::::callout{tone="info"}\n:::callout{tone="info"}\nx\n:::\n::::',
    ],
    ['an unknown attribute', ':::callout{tone="info" open="yes"}\nText\n:::'],
    ['props failing the schema', ':::callout{tone="loud"}\nText\n:::'],
    ['a label on a directive without a label field', '::metric[x]{value="1"}'],
    ['a label that is not plain text', ':::callout[*x*]{tone="info"}\nText\n:::'],
  ])('loads a container with %s as raw source', (_name, body) => {
    const doc = loadedWith(`${body}\n`);
    expect(tree(doc)).toEqual([raw(body)]);
    expect(savedWith(doc)).toBe(`${body}\n`);
  });
});
