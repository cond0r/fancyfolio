import type { Root } from 'mdast';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { type Processor, unified } from 'unified';
import { describe, expect, it } from 'vitest';
import {
  parseMarkdown,
  remarkDialect,
  remarkDirectiveAllowlist,
  stringifyMarkdown,
} from '../src/dialect.ts';
import { gfmHtml } from './gfm.ts';

function render(body: string): string {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkDialect)
      .use(remarkRehype)
      .use(rehypeStringify)
      .processSync(body),
  );
}

function renderAllowingNone(body: string): string {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkDialect)
      .use(remarkDirectiveAllowlist, { allow: [] })
      .use(remarkRehype)
      .use(rehypeStringify)
      .processSync(body),
  );
}

function nestedStrong(length: number): string {
  const pairs = Math.floor((length - 1) / 14);
  return `${'*a **a '.repeat(pairs)}b${' a** a*'.repeat(pairs)}`;
}

function nestedLines(indent: (line: number) => string, markers: number): string {
  let body = '';
  for (let line = 0; ; line += 1) {
    const next = `${indent(line)}${'- '.repeat(markers)}x${line}\n`;
    if (body.length + next.length > 20_000) return body;
    body += next;
  }
}

function tabsNest(markers: number): string {
  return nestedLines((line) => '\t'.repeat((line * markers * 2) / 4), markers);
}

function spaceNest(markers: number): string {
  return nestedLines((line) => ' '.repeat(line * markers * 2), markers);
}

function tabLines(lines: number): string {
  return Array.from({ length: lines }, (_, line) => `${'\t'.repeat(line)}- x`).join('\n');
}

function badges(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `![b${i}](https://example.test/${i}.svg)`);
}

function stars(count: number): string {
  return `${'*'.repeat(count)}a${'*'.repeat(count)}`;
}

function fallback(body: string, reason: string) {
  return {
    type: 'root',
    children: [{ type: 'code', value: body, data: { dialectFallback: reason } }],
  };
}

const columnBodies: [string, string][] = [
  ['9,999 dash markers', `${'- '.repeat(9_999)}a`],
  ['9,999 star markers', `${'* '.repeat(9_999)}a`],
  ['10,000 plus markers with tabs', '+\t'.repeat(10_000)],
  ['6,666 ordered markers', '1. '.repeat(6_666)],
  ['19,999 quote markers', `${'>'.repeat(19_999)}a`],
  ['dash markers after a footnote label', `[^a]: ${'- '.repeat(9_996)}a`],
  ['3,333 footnote labels', '[^a]: '.repeat(3_333)],
  ['dash markers after a byte order mark', `\uFEFF${'- '.repeat(9_998)}a`],
  ['ten dash markers then a footnote label, 800 times', `${'- '.repeat(10)}[^a]: `.repeat(800)],
  ['quoted footnote labels', '> [^a]: '.repeat(2_500)],
  ['listed footnote labels', '- [^a]: '.repeat(2_500)],
  ['dash markers under ten open fences', `${':::a\n'.repeat(10)}${'- '.repeat(9_970)}a`],
  ['quote markers under ten open fences', `${':::a\n'.repeat(10)}${'>'.repeat(19_940)}a`],
  ['dash markers in a quoted fence', `> :::a\n> ${'- '.repeat(9_990)}a`],
  ['101 lines nested by tabs', tabLines(101)],
  ['tab-indented runs of ten markers', tabsNest(10)],
  ['space-indented runs of ten markers', spaceNest(10)],
  ['a list after a 95-character footnote label', `[^${'a'.repeat(95)}]: - x`],
];

const imageBodies: [string, string][] = [
  ['3,333 nested images', `${'!['.repeat(3_333)}a${'](u)'.repeat(3_333)}`],
  ['3,999 nested images with empty destinations', `${'!['.repeat(3_999)}a${']()'.repeat(3_999)}`],
  ['101 badges on one line', badges(101).join(' ')],
];

const depthBodies: [string, string][] = [
  ['99 levels of strong emphasis', stars(198)],
  ['nested strong emphasis at 20,000 characters', nestedStrong(20_000)],
  ['60 lines nested by tabs', tabLines(60)],
];

const pipelines: [string, (body: string) => Root][] = [
  ['parseMarkdown', parseMarkdown],
  [
    'remark-parse with remarkDialect',
    (body) => unified().use(remarkParse).use(remarkDialect).parse(body),
  ],
];

describe.each(pipelines)('%s', (_pipeline, parse) => {
  it.each(columnBodies)('turns %s into one code block marked column', (_name, body) => {
    expect(parse(body)).toEqual(fallback(body, 'column'));
  });

  it('keeps a list after a 94-character footnote label', () => {
    expect(parse(`[^${'a'.repeat(94)}]: - x`).children[0]?.type).toBe('footnoteDefinition');
  });

  it.each(imageBodies)('turns %s into one code block marked images', (_name, body) => {
    expect(parse(body)).toEqual(fallback(body, 'images'));
  });

  it('keeps 100 badges as one paragraph of 100 images', () => {
    const [paragraph, ...rest] = parse(badges(100).join(' ')).children;
    expect(rest).toEqual([]);
    expect(paragraph?.type).toBe('paragraph');
    const images = paragraph?.type === 'paragraph' ? paragraph.children : [];
    expect(images.filter((child) => child.type === 'image')).toHaveLength(100);
  });

  it('keeps 300 images across paragraphs', () => {
    const types = parse(badges(300).join('\n\n')).children.map((child) => child.type);
    expect(types).toEqual(Array.from({ length: 300 }, () => 'paragraph'));
  });

  it('keeps 98 levels of strong emphasis as a paragraph', () => {
    expect(parse(stars(196)).children.map((child) => child.type)).toEqual(['paragraph']);
  });

  it.each(depthBodies)('turns %s into one code block marked depth', (_name, body) => {
    expect(parse(body)).toEqual(fallback(body, 'depth'));
  });
});

const honestBodies: [string, string][] = [
  ['39 dash markers then a dash', `${'- '.repeat(39)}-`],
  ['a thematic break of 10,000 dashes', `${'- '.repeat(9_999)}-`],
  [
    'quote and dash markers inside a fence',
    `\`\`\`\n${'>'.repeat(5_000)}\n${'- '.repeat(2_000)}\n\`\`\``,
  ],
  [
    'quote markers inside a fence in a list item',
    `- a\n  \`\`\`\n  ${'> '.repeat(3_000)}\n  \`\`\``,
  ],
  ['dash markers in indented code', `      ${'- '.repeat(500)}`],
  [
    '10 nested bullets',
    Array.from({ length: 10 }, (_, depth) => `${'  '.repeat(depth)}- item ${depth}`).join('\n'),
  ],
  [
    '10 nested ordered items',
    Array.from({ length: 10 }, (_, depth) => `${'    '.repeat(depth)}10. item ${depth}`).join('\n'),
  ],
  ['3 nested quotes', '> > > quote'],
  ['10 dash markers', `${'- '.repeat(10)}a`],
  ['100 badges', badges(100).join(' ')],
  ['300 images across paragraphs', badges(300).join('\n\n')],
];

describe('an honest body is never guarded', () => {
  it.each(honestBodies)('%s renders as CommonMark + GFM with no fallback', (_name, body) => {
    expect(render(body)).toBe(String(gfmHtml.processSync(body)));
    expect(JSON.stringify(parseMarkdown(body))).not.toContain('dialectFallback');
  });
});

const savedBodies: [string, string][] = [
  ['CRLF line endings', `${'- '.repeat(60)}a\r\nb\r\n`],
  ['bare CR line endings', `${'- '.repeat(60)}a\rb\r`],
  ['a byte order mark', `\uFEFF${'- '.repeat(60)}a`],
  ['a fence before deep quotes', `\`\`\`\ncode\n\`\`\`\n${'>'.repeat(120)}a\n`],
  ['trailing blank lines', `${'>'.repeat(120)}a\n\n\n`],
  ['198 stars', stars(198)],
  ['101 badges', badges(101).join(' ')],
];

describe('a guarded field saves as plain code that renders the same', () => {
  it.each(savedBodies)('with %s', (_name, body) => {
    const once = stringifyMarkdown(parseMarkdown(body));
    expect(render(once)).toBe(render(body));
    expect(stringifyMarkdown(parseMarkdown(once))).toBe(once);
    const [first] = parseMarkdown(once).children;
    expect(first?.type).toBe('code');
    expect(first?.data).toBeUndefined();
  });
});

function failingParser(this: Processor) {
  this.parser = () => {
    throw new Error('parser failed');
  };
}

describe('the guard never hides a failure or throws on a field', () => {
  it('lets an error from another parser through', () => {
    const processor = unified().use(remarkParse).use(failingParser).use(remarkDialect);
    expect(() => processor.parse('a')).toThrow('parser failed');
  });

  it.each([...columnBodies, ...imageBodies, ...depthBodies])(
    'renders %s as one code block through the allowlist',
    (_name, body) => {
      expect(renderAllowingNone(body)).toMatch(/^<pre><code>/);
    },
  );
});

function elapsed(body: string): number {
  const start = performance.now();
  parseMarkdown(body);
  return performance.now() - start;
}

describe('parse cost grows at most linearly', () => {
  it.each([
    ['a line of dash markers', (length: number) => `${'- '.repeat(length / 2 - 1)}a`],
    ['a line of star markers', (length: number) => `${'* '.repeat(length / 2 - 1)}a`],
    [
      'dash markers after a footnote label',
      (length: number) => `[^a]: ${'- '.repeat(length / 2 - 4)}a`,
    ],
    [
      'dash markers after a byte order mark',
      (length: number) => `\uFEFF${'- '.repeat(length / 2 - 1)}a`,
    ],
  ])('%s at 20,000 characters takes at most 3 times as long as at 10,000', (_name, make) => {
    const short = make(10_000);
    const long = make(20_000);
    let shortBest = Number.POSITIVE_INFINITY;
    let longBest = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 5; sample += 1) {
      shortBest = Math.min(shortBest, elapsed(short));
      longBest = Math.min(longBest, elapsed(long));
    }
    expect(longBest / shortBest).toBeLessThanOrEqual(3);
  });
});
