import type { Root } from 'mdast';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import {
  parseMarkdown,
  remarkDialect,
  remarkDirectiveAllowlist,
  stringifyMarkdown,
} from '../src/dialect.ts';
import { gfmHtml } from './gfm.ts';

function dialect(allow: readonly string[]) {
  return unified().use(remarkParse).use(remarkDialect).use(remarkDirectiveAllowlist, { allow });
}

function render(allow: readonly string[], body: string): string {
  return String(dialect(allow).use(remarkRehype).use(rehypeStringify).processSync(body));
}

function transformed(allow: readonly string[], body: string): Root {
  const processor = dialect(allow);
  const tree = processor.runSync(processor.parse(body), body);
  return JSON.parse(JSON.stringify(tree, (key, value) => (key === 'position' ? undefined : value)));
}

function directiveNodes(tree: Root): string[] {
  const found: string[] = [];
  JSON.stringify(tree, (_key, value) => {
    if (typeof value?.type === 'string' && value.type.endsWith('Directive')) {
      found.push(`${value.type}:${value.name}`);
    }
    return value;
  });
  return found;
}

const blockBodies = [
  '::metric{value="3x" label="faster deploys"}',
  ':::callout{tone="note"}\nInside **bold** and `code`\n:::',
  '::::outer\n:::inner\nhi\n:::\n::::',
  ':::callout\nnever closed\n\nmore',
  ':::x\n\n:::',
  ':::x\n    indented\n:::',
  '  :::x\n  in\n  :::',
  ':::x\r\nin\r\n:::',
  'Before 😀\n\n:::x{a="😀"}\nin 😀\n:::\n\nafter',
  '> :::callout\n> inner **b**\n> :::',
  '>:::x\n>in\n>:::',
  '>\t:::x\n>\tin\n>\t:::',
  '> :::x\n>> deep\n> :::',
  '> :::x\n>\n>     code\n> :::',
  '> > :::x\n> > y\n> > :::',
  '- item\n\n  :::callout\n  inner\n  :::',
  '- :::callout\n  inner\n  :::',
  ' - a\n\n   :::x\n   in\n   :::',
  '1.  :::x\n    in\n    :::',
  '1.  :::x\n    p1\n\n    p2\n    :::',
  '- :::x\n  p1\n\n      code\n  :::',
  '> :::x\n> p1\n>\n> p2\n> :::',
  '- a\n  - b\n\n    :::x\n    in **b**\n    :::',
  '> - a\n>\n>   :::x\n>   in\n>   :::',
];

const hostileBodies = [
  '::x{onclick="alert(1)" class="evil" id="a" style="color:red"}',
  ':::x{href="javascript:alert(1)"}\n<script>alert(1)</script>\n:::',
  '::x[<img src=x onerror=alert(1)>]{src="data:text/html,x"}',
  ':::x{.evil #a onmouseover="alert(1)"}\n<b onclick="alert(1)">b</b>\n:::',
  '::x{__proto__="polluted" constructor="c"}',
];

const inTreeHtml = new Map([
  [
    ':::callout{tone="note"}\nInside **bold** and `code`\n:::',
    '<p>:::callout{tone="note"}</p>\n<p>Inside <strong>bold</strong> and <code>code</code></p>\n<p>:::</p>',
  ],
  [
    '::::outer\n:::inner\nhi\n:::\n::::',
    '<p>:::outer</p>\n<p>:::inner</p>\n<p>hi</p>\n<p>:::</p>\n<p>:::</p>',
  ],
  [
    ':::callout\nnever closed\n\nmore',
    '<p>:::callout</p>\n<p>never closed</p>\n<p>more</p>\n<p>:::</p>',
  ],
  [':::x[a *b*]\nin\n:::', '<p>:::x[a _b_]</p>\n<p>in</p>\n<p>:::</p>'],
  [':::x\n\n:::', '<p>:::x</p>\n<p>:::</p>'],
  [':::x\n    indented\n:::', '<p>:::x</p>\n<pre><code>indented\n</code></pre>\n<p>:::</p>'],
  [':::x\r\nin\r\n:::', '<p>:::x</p>\n<p>in</p>\n<p>:::</p>'],
  [':::x\n- a\n:::', '<p>:::x</p>\n<ul>\n<li>a</li>\n</ul>\n<p>:::</p>'],
  [
    '- item\n\n  :::callout\n  inner\n  :::',
    '<ul>\n<li>\n<p>item</p>\n<p>:::callout</p>\n<p>inner</p>\n<p>:::</p>\n</li>\n</ul>',
  ],
  ['  :::x\n  in\n  :::', '<p>:::x</p>\n<p>in</p>\n<p>:::</p>'],
  [
    'Before 😀\n\n:::x{a="😀"}\nin 😀\n:::\n\nafter',
    '<p>Before 😀</p>\n<p>:::x{a="😀"}</p>\n<p>in 😀</p>\n<p>:::</p>\n<p>after</p>',
  ],
  [
    '> :::callout\n> inner **b**\n> :::',
    '<blockquote>\n<p>:::callout</p>\n<p>inner <strong>b</strong></p>\n<p>:::</p>\n</blockquote>',
  ],
  ['>:::x\n>in\n>:::', '<blockquote>\n<p>:::x</p>\n<p>in</p>\n<p>:::</p>\n</blockquote>'],
  ['>\t:::x\n>\tin\n>\t:::', '<blockquote>\n<p>:::x</p>\n<p>in</p>\n<p>:::</p>\n</blockquote>'],
  [
    '> :::x\n>> deep\n> :::',
    '<blockquote>\n<p>:::x</p>\n<blockquote>\n<p>deep</p>\n</blockquote>\n<p>:::</p>\n</blockquote>',
  ],
  [
    '> > :::x\n> > y\n> > :::',
    '<blockquote>\n<blockquote>\n<p>:::x</p>\n<p>y</p>\n<p>:::</p>\n</blockquote>\n</blockquote>',
  ],
  [
    ' - a\n\n   :::x\n   in\n   :::',
    '<ul>\n<li>\n<p>a</p>\n<p>:::x</p>\n<p>in</p>\n<p>:::</p>\n</li>\n</ul>',
  ],
  [
    '1.  :::x\n    p1\n\n    p2\n    :::',
    '<ol>\n<li>\n<p>:::x</p>\n<p>p1</p>\n<p>p2</p>\n<p>:::</p>\n</li>\n</ol>',
  ],
  [
    '- :::x\n  p1\n\n      code\n  :::',
    '<ul>\n<li>\n<p>:::x</p>\n<p>p1</p>\n<pre><code>code\n</code></pre>\n<p>:::</p>\n</li>\n</ul>',
  ],
  [
    '> :::x\n> p1\n>\n> p2\n> :::',
    '<blockquote>\n<p>:::x</p>\n<p>p1</p>\n<p>p2</p>\n<p>:::</p>\n</blockquote>',
  ],
  [
    '- a\n  - b\n\n    :::x\n    in **b**\n    :::',
    '<ul>\n<li>a\n<ul>\n<li>\n<p>b</p>\n<p>:::x</p>\n<p>in <strong>b</strong></p>\n<p>:::</p>\n</li>\n</ul>\n</li>\n</ul>',
  ],
  [
    '> - a\n>\n>   :::x\n>   in\n>   :::',
    '<blockquote>\n<ul>\n<li>\n<p>a</p>\n<p>:::x</p>\n<p>in</p>\n<p>:::</p>\n</li>\n</ul>\n</blockquote>',
  ],
  ['::x[label *em*]{a=1}', '<p>::x[label _em_]{a="1"}</p>'],
  ['::x{a="&#91;y&#93;&#40;javascript:alert(1)&#41;"}', '<p>::x{a="[y](javascript:alert(1))"}</p>'],
]);

describe('with an empty allowlist a block directive renders as its opening line and closing fence', () => {
  it.each(blockBodies.filter((body) => !inTreeHtml.has(body)))(
    '%j renders the same HTML as CommonMark + GFM',
    (body) => {
      expect(render([], body)).toBe(String(gfmHtml.processSync(body)));
    },
  );

  it.each([...inTreeHtml])('%j renders in the tree', (body, html) => {
    expect(render([], body)).toBe(html);
  });

  it('still formats inline markdown inside a container', () => {
    expect(render([], ':::callout{tone="note"}\nInside **bold**\n:::')).toBe(
      '<p>:::callout{tone="note"}</p>\n<p>Inside <strong>bold</strong></p>\n<p>:::</p>',
    );
  });

  it('starts a block at a directive line, which plain GFM would join to the paragraph', () => {
    expect(render([], 'para\n::metric{a="1"}')).toBe('<p>para</p>\n<p>::metric{a="1"}</p>');
  });

  it.each([...blockBodies, ...hostileBodies])('%j leaves no directive node', (body) => {
    expect(directiveNodes(transformed([], body))).toEqual([]);
  });
});

describe('a directive outside the allowlist carries no attribute into the HTML', () => {
  const exactHtml = new Map([
    [hostileBodies[0], '<p>::x{#a .evil onclick="alert(1)" style="color:red"}</p>'],
    [hostileBodies[2], '<p>::x[&#x3C;img src=x onerror=alert(1)>]{src="data:text/html,x"}</p>'],
    [hostileBodies[3], '<p>:::x{#a .evil onmouseover="alert(1)"}</p>\n<p>b</p>\n<p>:::</p>'],
    [hostileBodies[4], '<p>::x{constructor="c"}</p>'],
  ]);

  it.each(hostileBodies)('%j renders with no attribute on any tag', (body) => {
    const html = render([], body);
    expect(html).toBe(exactHtml.get(body) ?? String(gfmHtml.processSync(body)));
    expect(html).not.toMatch(
      /<[a-z][^>]*\s(onclick|onmouseover|onerror|class|id|style|href|src)=/i,
    );
  });

  it('pollutes no prototype', () => {
    render([], '::x{__proto__="polluted" constructor="c"}');
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});

describe('an allowlisted name stays a directive', () => {
  const body =
    '::metric{value="3x"}\n\n::other{a="1"}\n\n:::callout\n::metric{value="2"}\n:::\n\n:::metric\n::other\n:::';

  it('keeps only metric as a directive node', () => {
    expect(transformed(['metric'], body).children).toEqual([
      { type: 'leafDirective', name: 'metric', attributes: { value: '3x' }, children: [] },
      { type: 'paragraph', children: [{ type: 'text', value: '::other{a="1"}' }] },
      { type: 'paragraph', children: [{ type: 'text', value: ':::callout' }] },
      { type: 'leafDirective', name: 'metric', attributes: { value: '2' }, children: [] },
      { type: 'paragraph', children: [{ type: 'text', value: ':::' }] },
      {
        type: 'containerDirective',
        name: 'metric',
        attributes: {},
        children: [{ type: 'paragraph', children: [{ type: 'text', value: '::other' }] }],
      },
    ]);
  });

  it.each(['Metric', 'metrics', 'metri', ' metric'])('does not match %j', (name) => {
    expect(directiveNodes(transformed([name], '::metric{value="3x"}'))).toEqual([]);
  });
});

it('renders a directive without a source position as its canonical source', () => {
  const tree: Root = {
    type: 'root',
    children: [{ type: 'leafDirective', name: 'x', attributes: {}, children: [] }],
  };
  expect(unified().use(remarkDirectiveAllowlist, { allow: [] }).runSync(tree)).toMatchObject({
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: '::x' }] }],
  });
});

it('resolves references inside an unknown container like any markdown', () => {
  const body = ':::x\nSee [the docs][d] and [^n].\n:::\n\n[d]: https://example.test\n\n[^n]: note';
  const html = render([], body);
  expect(html).toContain('<a href="https://example.test">the docs</a>');
  expect(html.startsWith('<p>:::x</p>\n<p>See ')).toBe(true);
});

it('reads the source of a body given as bytes', () => {
  const body = 'Before 😀\n\n:::x{a="😀"}\nin 😀\n:::';
  const bytes = new TextEncoder().encode(body);
  const processor = dialect([]).use(remarkRehype).use(rehypeStringify);
  expect(String(processor.processSync(bytes))).toBe(render([], body));
});

const canonicalCorpus = [
  ...blockBodies,
  ...hostileBodies,
  'Claim[^1].\n\n[^1]: Note\n\n    :::callout\n    inside\n    :::',
  'Claim[^1].\n\n[^1]: :::callout\n    inside\n    :::',
  '-\t:::x\n\tin\n\t:::',
  '- a\n\n\t:::x\n\tin\n\t:::',
  '10. a\n\n    :::x\n    in\n    :::',
  '> - a\n>\n>   :::x\n>   in\n  :::',
  '   > :::x\n   > in\n   > :::',
  '> :::x\n>     code\n> :::',
  '- :::x\n  ```\n  a\n    b\n  ```\n  :::',
  '- > :::x\n  > in\n  > :::',
  '- :::callout\n  ::x\n  :::',
  '> ::x{a="1"}',
  ':::x\n| a |\n| - |\n| 1 |\n:::',
  ':::x\n```\ncode\n:::',
  '> :::x\r\n> in\r\n> :::',
  '> :::x\nlazy\n> :::',
  '::metric{a="1" a="2"}',
  '::metric{value=\'say "hi"\'}',
  ':::callout\n```\n:::\n```\n:::',
  'Claim[^1].\n\n[^1]: Note\n\n    :::callout\n    p1\n\n    p2\n    :::',
  '\uFEFF::x{a=1}',
  '\uFEFF:::x\nin\n:::\n\nafter',
  '> :::x\r> in\r> :::',
  '- :::x\r  in\r  :::',
  '\uFEFF\n::x\n\ntext',
  '::constructor',
  '::__proto__{a=1}',
];

describe('an unknown directive renders as its canonical source', () => {
  it.each(canonicalCorpus)('%j renders the same after one save', (body) => {
    const saved = stringifyMarkdown(parseMarkdown(body));
    expect(render([], body)).toBe(render([], saved));
    expect(render(['callout', 'metric'], body)).toBe(render(['callout', 'metric'], saved));
  });
});

const linkWithScript = /<[a-z][^>]*\shref="javascript:/i;
const attributeFromText = /<[a-z][^>]*\s(on\w+|style|class|id|src|href)=/i;

describe('directive text never becomes an attribute or a script link', () => {
  const xssBodies = [
    ...hostileBodies,
    ':::x{onload=alert(1)}\n<iframe src="javascript:alert(1)"></iframe>\n:::',
    '::x{__proto__="p" constructor="c" prototype="p" hasOwnProperty="h"}',
    '::x{a="&lt;script&gt;" b="&#x6a;avascript:alert(1)"}',
    '::x{a="&lt;img src=x onerror=alert(1)&gt;"}',
    '::x{a="&#91;y&#93;&#40;javascript:alert(1)&#41;"}',
    '::x{a="&#91;y&#93;&#40;https://evil.test&#41;"}',
    '::x[&#91;y&#93;&#40;javascript:alert(1)&#41;]',
    '::x[&lt;b onclick=1&gt;]',
    '::x{a="x&#10;<script>alert(1)</script>"}',
    '::x{a="x&#10;&#10;<script>alert(1)</script>"}',
    '::x{a="x&#10;# heading"}',
    '::x{a="x&#10;&#10;:::y&#10;in"}',
    '::x{a="&#10;&#10;[z]: javascript:alert(1)&#10;&#10;[q][z]"}',
    ':::x\n&lt;script&gt;\n:::',
  ];

  it.each(xssBodies)('%j renders no script link and no attribute from text', (body) => {
    const html = render([], body);
    expect(html).not.toMatch(linkWithScript);
    expect(html).not.toMatch(attributeFromText);
  });

  it('renders no script link for 2,000 seeded random bodies', () => {
    const tokens = [
      '::',
      ':::',
      '::::',
      'x',
      'y',
      '{a=1}',
      '{#i .c b="&#91;q&#93;&#40;javascript:1&#41;"}',
      '[l]',
      '[&lt;b&gt;]',
      '\n',
      '\n\n',
      '> ',
      '- ',
      '[^1]: ',
      '|',
      '-|-',
      '`',
      '*',
      '_',
      '&#10;',
      '<b>',
      '"',
      "'",
      '}',
      '{',
      '\r\n',
      '2*3*4',
      '![a](b)',
      '    ',
    ];
    let seed = 777;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const processor = dialect(['y']).use(remarkRehype).use(rehypeStringify);
    let scriptLinks = 0;
    for (let i = 0; i < 2000; i++) {
      let body = '';
      for (let j = 1 + next(20); j > 0; j--) body += tokens[next(tokens.length)];
      if (linkWithScript.test(String(processor.processSync(body)))) scriptLinks++;
    }
    expect(scriptLinks).toBe(0);
  });
});

describe('a table inside an unknown container keeps its size', () => {
  const tblIn = (columns: number, rows: number) =>
    ':::b\n' +
    'a|'.repeat(columns - 1) +
    'a\n' +
    '-|'.repeat(columns - 1) +
    '-\n' +
    'a\n'.repeat(rows) +
    ':::';

  it('pads no row to the header width', () => {
    const { children } = transformed([], tblIn(248, 490));
    expect(children.map((child) => child.type)).toEqual(['paragraph', 'table', 'paragraph']);
    const table = children[1];
    if (table?.type !== 'table') throw new Error('no table');
    expect(table.children).toHaveLength(491);
    expect(table.children[1]?.children).toHaveLength(1);
  });
});
