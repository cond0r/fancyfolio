import type { ListItem, Nodes, Parents, Root, RootContent } from 'mdast';
import { directiveFromMarkdown, directiveToMarkdown } from 'mdast-util-directive';
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from 'mdast-util-gfm-footnote';
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown, gfmTableToMarkdown } from 'mdast-util-gfm-table';
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from 'mdast-util-gfm-task-list-item';
import { directive } from 'micromark-extension-directive';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { type Data, type Processor, type Transformer, unified } from 'unified';

export type DialectFallback = 'column' | 'images' | 'depth';

declare module 'mdast' {
  interface CodeData {
    dialectFallback?: DialectFallback;
  }
}

type MicromarkExtension = NonNullable<Data['micromarkExtensions']>[number];
type Construct = Exclude<
  NonNullable<NonNullable<MicromarkExtension['document']>[string]>,
  unknown[]
>;

const maxDepth = 100;
const maxColumn = 100;
const maxImageStarts = 100;
const containerStarts = [42, 43, 45, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 62, 91];

class DialectGuardStop extends Error {
  readonly reason: DialectFallback;

  constructor(reason: DialectFallback) {
    super(reason);
    this.reason = reason;
  }
}

const columnGuard: Construct = {
  name: 'dialectColumnGuard',
  tokenize(_effects, _ok, nok) {
    return (code) => {
      if (this.now().column > maxColumn) throw new DialectGuardStop('column');
      return nok(code);
    };
  },
};

function remarkGfmParts(this: Processor) {
  const data = this.data();
  data.micromarkExtensions = [
    ...(data.micromarkExtensions ?? []),
    gfmFootnote(),
    gfmStrikethrough(),
    gfmTable(),
    gfmTaskListItem(),
  ];
  data.fromMarkdownExtensions = [
    ...(data.fromMarkdownExtensions ?? []),
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ];
  data.toMarkdownExtensions = [
    ...(data.toMarkdownExtensions ?? []),
    gfmFootnoteToMarkdown(),
    gfmStrikethroughToMarkdown(),
    gfmTableToMarkdown(),
    gfmTaskListItemToMarkdown(),
  ];
}

export function remarkDialect(this: Processor) {
  remarkGfmParts.call(this);
  const data = this.data();
  data.settings = { ...data.settings, bullet: '-', emphasis: '_', rule: '-' };
  const toMarkdown = directiveToMarkdown();
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), { flow: directive().flow }];
  data.fromMarkdownExtensions = [...(data.fromMarkdownExtensions ?? []), directiveFromMarkdown()];
  data.toMarkdownExtensions = [
    ...(data.toMarkdownExtensions ?? []),
    {
      ...toMarkdown,
      unsafe: toMarkdown.unsafe?.filter((rule) => ![rule.inConstruct].flat().includes('phrasing')),
    },
  ];
  remarkGuard.call(this);
}

function remarkGuard(this: Processor) {
  const imageStarts = new WeakMap<object, number>();
  const imageBudget: Construct = {
    name: 'dialectImageBudget',
    tokenize(effects, _ok, nok) {
      return (code) => {
        effects.enter('labelImage');
        effects.consume(code);
        return (next) => {
          if (next === 91) {
            const starts = (imageStarts.get(this) ?? 0) + 1;
            if (starts > maxImageStarts) throw new DialectGuardStop('images');
            imageStarts.set(this, starts);
          }
          return nok(next);
        };
      };
    },
  };
  const data = this.data();
  data.micromarkExtensions = [
    ...(data.micromarkExtensions ?? []),
    {
      document: Object.fromEntries(
        containerStarts.map((code): [number, Construct] => [code, columnGuard]),
      ),
    },
    { text: { 33: imageBudget } },
  ];
  const parse = this.parser;
  if (parse === undefined) return;
  this.parser = (document, file) => {
    try {
      const tree = parse(document, file);
      return isRoot(tree) && deeperThan(tree, maxDepth) ? fallback(document, 'depth') : tree;
    } catch (error) {
      if (error instanceof DialectGuardStop) return fallback(document, error.reason);
      throw error;
    }
  };
}

function isRoot(node: { type: string }): node is Root {
  return node.type === 'root';
}

function fallback(document: string, reason: DialectFallback): Root {
  return {
    type: 'root',
    children: [
      {
        type: 'code',
        value: document.replace(/\r\n?/g, '\n'),
        data: { dialectFallback: reason },
      },
    ],
  };
}

const dialectParser = unified().use(remarkParse).use(remarkDialect).freeze();
const dialectSerializer = unified().use(remarkStringify).use(remarkDialect).freeze();
const plainParser = unified().use(remarkParse).use(remarkGfmParts).freeze();

export function parseMarkdown(markdown: string): Root {
  return dialectParser.parse(markdown);
}

export function stringifyMarkdown(tree: Root): string {
  return dialectSerializer.stringify(tree);
}

function deeperThan(tree: Root, limit: number): boolean {
  const stack: [Nodes, number][] = [[tree, 0]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [node, depth] = next;
    if (depth > limit) return true;
    if ('children' in node) {
      const children: Nodes[] = node.children;
      for (const child of children) stack.push([child, depth + 1]);
    }
  }
  return false;
}

export function remarkDirectiveAllowlist(options: { allow: readonly string[] }): Transformer<Root> {
  const allow = new Set(options.allow);
  return (tree, file) => {
    replaceUnknown(tree, [], allow, String(file));
  };
}

function replaceUnknown(parent: Parents, ancestors: Parents[], allow: Set<string>, source: string) {
  const chain = [...ancestors, parent];
  const children: Nodes[] = parent.children;
  const replaced = children.flatMap((child): Nodes[] => {
    if (
      (child.type === 'leafDirective' || child.type === 'containerDirective') &&
      !allow.has(child.name)
    ) {
      return asPlainGfm(child, chain, source);
    }
    if ('children' in child) replaceUnknown(child, chain, allow, source);
    return [child];
  });
  (parent as { children: Nodes[] }).children = replaced;
}

function asPlainGfm(node: Nodes, chain: Parents[], source: string): RootContent[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error('A directive without a source position cannot render as its source');
  }
  const [first = '', ...rest] = source.slice(start, end).split('\n');
  const lines = [first, ...rest.map((line) => chain.reduce(stripPrefix, line))];
  return plainParser.parse(lines.join('\n')).children;
}

function stripPrefix(line: string, ancestor: Parents): string {
  if (ancestor.type === 'blockquote') return line.replace(/^ {0,3}>[ \t]?/, '');
  if (ancestor.type === 'listItem') {
    const indent = line.length - line.trimStart().length;
    return line.slice(Math.min(indent, contentIndent(ancestor)));
  }
  return line;
}

function contentIndent(item: ListItem): number {
  const content = item.children[0]?.position?.start.column;
  const marker = item.position?.start.column;
  return content === undefined || marker === undefined ? 0 : content - marker;
}
