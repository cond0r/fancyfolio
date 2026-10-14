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

const changedBlockHtml = new Map([
  [':::callout\nnever closed\n\nmore', '<p>:::callout\nnever closed</p>\n<p>more\n:::</p>'],
  [':::x\n\n:::', '<p>:::x\n:::</p>'],
  [':::x\n    indented\n:::', '<p>:::x</p>\n<pre><code>indented\n</code></pre>\n<p>:::</p>'],
  [':::x\r\nin\r\n:::', '<p>:::x\nin\n:::</p>'],
]);

describe('with an empty allowlist a block directive renders as its canonical source', () => {
  it.each(blockBodies.filter((body) => !changedBlockHtml.has(body)))(
    '%j renders the same HTML as CommonMark + GFM',
    (body) => {
      expect(render([], body)).toBe(String(gfmHtml.processSync(body)));
    },
  );

  it.each([...changedBlockHtml])('%j renders its canonical source', (body, html) => {
    expect(render([], body)).toBe(html);
  });

  it('still formats inline markdown inside a container', () => {
    expect(render([], ':::callout{tone="note"}\nInside **bold**\n:::')).toBe(
      '<p>:::callout{tone="note"}\nInside <strong>bold</strong>\n:::</p>',
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
    [hostileBodies[3], '<p>:::x{#a .evil onmouseover="alert(1)"}\nb\n:::</p>'],
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
      {
        type: 'paragraph',
        children: [{ type: 'text', value: ':::callout\n::metric{value="2"}\n:::' }],
      },
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

it('keeps references inside an unknown container as text', () => {
  const body = ':::x\nSee [the docs][d] and [^n].\n:::\n\n[d]: https://example.test\n\n[^n]: note';
  expect(render([], body).startsWith('<p>:::x\nSee [the docs][d] and [^n].\n:::</p>')).toBe(true);
});

it('re-parses the canonical source through the guarded parser', () => {
  const body = `:::x\n${'>'.repeat(60)} a\n:::`;
  expect(parseMarkdown(body).children[0]?.type).toBe('containerDirective');
  const html = render([], body);
  expect(html.startsWith('<pre><code>:::x\n')).toBe(true);
  expect(html).not.toContain('<blockquote>');
});

it('reads the source of a body given as bytes', () => {
  const body = 'Before 😀\n\n:::x{a="😀"}\nin 😀\n:::';
  const bytes = new TextEncoder().encode(body);
  const processor = dialect([]).use(remarkRehype).use(rehypeStringify);
  expect(String(processor.processSync(bytes))).toBe(String(gfmHtml.processSync(body)));
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
