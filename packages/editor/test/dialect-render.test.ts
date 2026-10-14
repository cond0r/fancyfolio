import type { Root } from 'mdast';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { remarkDialect, remarkDirectiveAllowlist } from '../src/dialect.ts';
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

describe('with an empty allowlist a block directive renders as its source parsed as GFM', () => {
  it.each(blockBodies)('%j renders the same HTML as CommonMark + GFM', (body) => {
    expect(render([], body)).toBe(String(gfmHtml.processSync(body)));
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
  it.each(hostileBodies)('%j renders as plain GFM with no attribute on any tag', (body) => {
    const html = render([], body);
    expect(html).toBe(String(gfmHtml.processSync(body)));
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

it('refuses a directive without a source position', () => {
  const tree: Root = {
    type: 'root',
    children: [{ type: 'leafDirective', name: 'x', attributes: {}, children: [] }],
  };
  expect(() => unified().use(remarkDirectiveAllowlist, { allow: [] }).runSync(tree)).toThrow(
    'A directive without a source position cannot render as its source',
  );
});

it('reads the source of a body given as bytes', () => {
  const body = 'Before 😀\n\n:::x{a="😀"}\nin 😀\n:::';
  const bytes = new TextEncoder().encode(body);
  const processor = dialect([]).use(remarkRehype).use(rehypeStringify);
  expect(String(processor.processSync(bytes))).toBe(String(gfmHtml.processSync(body)));
});
