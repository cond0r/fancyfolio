import type { PhrasingContent, Root } from 'mdast';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { parseMarkdown, remarkDialect, stringifyMarkdown } from '../src/dialect.ts';
import { gfmHtml } from './gfm.ts';

const proseWithColons = [
  'Status:done and TODO:fix the build.',
  'Set NODE_ENV:production then run.',
  'Ratio 3:1 at 10:30',
  'Key takeaway:latency fell 40%.',
  'std::vector and a::b',
  'text :abbr[HTML]{title="x"} inline',
];

const dialectHtml = unified()
  .use(remarkParse)
  .use(remarkDialect)
  .use(remarkRehype)
  .use(rehypeStringify);

function withoutPositions(tree: Root): Root {
  return JSON.parse(JSON.stringify(tree, (key, value) => (key === 'position' ? undefined : value)));
}

function directives(tree: Root): string[] {
  const found: string[] = [];
  JSON.stringify(tree, (_key, value) => {
    if (typeof value?.type === 'string' && value.type.endsWith('Directive')) {
      found.push(`${value.type}:${value.name}`);
    }
    return value;
  });
  return found;
}

function links(tree: Root): string[] {
  const found: string[] = [];
  JSON.stringify(tree, (_key, value) => {
    if (value?.type === 'link') found.push(value.url);
    return value;
  });
  return found;
}

describe('a colon in prose is never a directive', () => {
  it.each(proseWithColons)('%j parses with no directive node', (body) => {
    expect(directives(parseMarkdown(body))).toEqual([]);
  });

  it.each(proseWithColons)('%j renders the same HTML as CommonMark + GFM', (body) => {
    expect(String(dialectHtml.processSync(body))).toBe(String(gfmHtml.processSync(body)));
  });

  it('keeps the text a text directive would have dropped', () => {
    expect(String(dialectHtml.processSync('Ratio 3:1 at 10:30'))).toBe('<p>Ratio 3:1 at 10:30</p>');
  });
});

describe('a colon in prose is never escaped', () => {
  it.each(proseWithColons)(
    '%j serializes without \\: and parses back to the same mdast',
    (body) => {
      const tree = withoutPositions(parseMarkdown(body));
      const markdown = stringifyMarkdown(tree);
      expect(markdown).not.toContain('\\:');
      expect(withoutPositions(parseMarkdown(markdown))).toEqual(tree);
    },
  );

  it.each(proseWithColons.slice(0, 5))('%j round-trips byte for byte', (body) => {
    expect(stringifyMarkdown(parseMarkdown(body))).toBe(`${body}\n`);
  });

  it('serializes a model text node with colons as typed', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'Meet at 10:30, Status:done, std::vector' }],
        },
      ],
    };
    const markdown = stringifyMarkdown(tree);
    expect(markdown).toBe('Meet at 10:30, Status:done, std::vector\n');
    expect(withoutPositions(parseMarkdown(markdown))).toEqual(tree);
  });
});

describe('block directives', () => {
  it('parses a leaf directive with its attributes', () => {
    expect(withoutPositions(parseMarkdown('::name{a="1"}')).children).toEqual([
      { type: 'leafDirective', name: 'name', attributes: { a: '1' }, children: [] },
    ]);
  });

  it('parses a container directive with markdown inside', () => {
    expect(withoutPositions(parseMarkdown(':::name\nx\n:::')).children).toEqual([
      {
        type: 'containerDirective',
        name: 'name',
        attributes: {},
        children: [{ type: 'paragraph', children: [{ type: 'text', value: 'x' }] }],
      },
    ]);
  });

  it('parses a container nested in one with a longer fence', () => {
    expect(withoutPositions(parseMarkdown('::::outer\n:::inner\nhi\n:::\n::::')).children).toEqual([
      {
        type: 'containerDirective',
        name: 'outer',
        attributes: {},
        children: [
          {
            type: 'containerDirective',
            name: 'inner',
            attributes: {},
            children: [{ type: 'paragraph', children: [{ type: 'text', value: 'hi' }] }],
          },
        ],
      },
    ]);
  });

  it.each([
    '::name{a="1"}',
    ':::name\nx\n:::',
    '::::outer\n:::inner\nhi\n:::\n::::',
    ':::callout{tone="note"}\nInside **bold**\n:::',
  ])('%j round-trips byte for byte', (body) => {
    expect(stringifyMarkdown(parseMarkdown(body))).toBe(`${body}\n`);
  });

  it.each([
    ['::metric{value="1"} typed as text', ':\\:metric{value="1"} typed as text\n'],
    [':::callout typed as text', '::\\:callout typed as text\n'],
  ])(
    'escapes a text node that starts with %j and parses it back as that text',
    (value, expected) => {
      const tree: Root = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
      };
      const markdown = stringifyMarkdown(tree);
      expect(markdown).toBe(expected);
      expect(withoutPositions(parseMarkdown(markdown))).toEqual(tree);
    },
  );
});

describe('GFM and the canonical style', () => {
  const canonical =
    '- [x] done\n- [ ] open\n\n*em* and **strong** and `code`\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~\n\n1. one\n2. two\n\n> quote\n\n```ts\nconst a = 1;\n```\n\n[link](https://example.test) and <https://example.test>\n\n::metric{value="3x"}\n\n:::callout{tone="note"}\nInside **bold**\n:::\n';

  it('renders GFM tables, strikethrough and task lists like CommonMark + those GFM parts', () => {
    const body = '| a |\n| - |\n| b |\n\n~~gone~~\n\n- [x] done';
    const html = String(dialectHtml.processSync(body));
    expect(html).toBe(String(gfmHtml.processSync(body)));
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
  });

  it('round-trips a canonical body byte for byte', () => {
    expect(stringifyMarkdown(parseMarkdown(canonical))).toBe(canonical);
  });

  it('writes - bullets, * emphasis and --- rules, stable after one pass', () => {
    const once = stringifyMarkdown(parseMarkdown('* a\n\n*em* __s__\n\n***'));
    expect(once).toBe('- a\n\n*em* **s**\n\n---\n');
    expect(stringifyMarkdown(parseMarkdown(once))).toBe(once);
  });
});

describe('a bare URL or email address stays text', () => {
  it.each(['https://example.test', 'www.example.test', 'ines@example.test'])(
    '%s parses as text and stringifies byte for byte',
    (address) => {
      const body = `Write to ${address} today.`;
      expect(links(parseMarkdown(body))).toEqual([]);
      expect(withoutPositions(parseMarkdown(body)).children).toEqual([
        { type: 'paragraph', children: [{ type: 'text', value: body }] },
      ]);
      expect(stringifyMarkdown(parseMarkdown(body))).toBe(`${body}\n`);
    },
  );

  it('still links <https://example.test> and [x](https://example.test)', () => {
    expect(links(parseMarkdown('<https://example.test> and [x](https://example.test)'))).toEqual([
      'https://example.test',
      'https://example.test',
    ]);
  });
});

const t = (value: string): PhrasingContent => ({ type: 'text', value });
const para = (...children: PhrasingContent[]) => ({ type: 'paragraph' as const, children });
const rootOf = (...children: Root['children']): Root => ({ type: 'root', children });

const adjacentText: [string, Root, string][] = [
  ['root', rootOf(para(t(':'), t(':metric{value="1"}'))), ':\\:metric{value="1"}\n'],
  ['container name', rootOf(para(t('::'), t(':callout'))), '::\\:callout\n'],
  [
    'blockquote',
    rootOf({ type: 'blockquote', children: [para(t(':'), t(':metric'))] }),
    '> :\\:metric\n',
  ],
  [
    'list item',
    rootOf({
      type: 'list',
      ordered: false,
      spread: false,
      children: [{ type: 'listItem', spread: false, children: [para(t('::'), t(':callout'))] }],
    }),
    '- ::\\:callout\n',
  ],
  [
    'footnote definition',
    rootOf(para(t('a'), { type: 'footnoteReference', identifier: '1', label: '1' }), {
      type: 'footnoteDefinition',
      identifier: '1',
      label: '1',
      children: [para(t(':'), t(':metric'))],
    }),
    'a[^1]\n\n[^1]: :\\:metric\n',
  ],
  [
    'after a break',
    rootOf(para(t('a'), { type: 'break' }, t(':'), t(':metric'))),
    'a\\\n:\\:metric\n',
  ],
  ['after a newline', rootOf(para(t('a\n:'), t(':metric'))), 'a\n:\\:metric\n'],
  [
    'across an empty html node',
    rootOf(para(t(':'), { type: 'html', value: '' }, t(':metric'))),
    ':\\:metric\n',
  ],
];

describe('adjacent text nodes never serialize as a live directive', () => {
  it.each(adjacentText)('%s', (_name, tree, expected) => {
    const before = structuredClone(tree);
    const markdown = stringifyMarkdown(tree);
    expect(markdown).toBe(expected);
    expect(directives(parseMarkdown(markdown))).toEqual([]);
    expect(tree).toEqual(before);
  });
});

describe('emphasis is written with * and never as character references', () => {
  it.each([
    ['2*3*4', '2*3*4\n'],
    ['un*frigging*believable', 'un*frigging*believable\n'],
    ['snake_case_name', undefined],
    [
      '_em_ and *em* and __strong__ and **strong**',
      '*em* and *em* and **strong** and **strong**\n',
    ],
    ['a *b* c', undefined],
    ['foo*bar*', undefined],
    ['*foo*bar', undefined],
    ['x **y** z', undefined],
    ['***both***', undefined],
    ['see *a*, *b*.', undefined],
    ['file_name.md and *x*', undefined],
    ['(*x*)', undefined],
    ['"_y_"', '"*y*"\n'],
    ['_a_b', undefined],
    ['a_b_', undefined],
    ['* not a list item *', undefined],
    ['mid**word**strong', undefined],
  ])('%j', (body, expected) => {
    const markdown = stringifyMarkdown(parseMarkdown(body));
    expect(markdown).not.toMatch(/&#x/);
    if (expected !== undefined) expect(markdown).toBe(expected);
    expect(withoutPositions(parseMarkdown(markdown))).toEqual(
      withoutPositions(parseMarkdown(body)),
    );
  });
});

describe('table pipes are not aligned on save', () => {
  it('keeps a 9,000-character cell table near its source size', () => {
    const body = `| ${'h'.repeat(9_000)} | b |\n|-|-|\n${'| a | b |\n'.repeat(1_000)}`;
    expect(stringifyMarkdown(parseMarkdown(body)).length).toBeLessThanOrEqual(19_100);
  });

  it.each([
    ['| a | bbb |\n|-|-|\n| ccccc | d |', '| a | bbb |\n| - | - |\n| ccccc | d |\n'],
    [
      '| Left | Center | Right |\n|:-----|:------:|------:|\n| `a\\|b` | x | 1 |',
      '| Left | Center | Right |\n| :- | :-: | -: |\n| `a\\|b` | x | 1 |\n',
    ],
  ])('%j', (body, expected) => {
    expect(stringifyMarkdown(parseMarkdown(body))).toBe(expected);
  });
});
