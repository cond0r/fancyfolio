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
import { type Processor, type Transformer, unified } from 'unified';

const maxDepth = 100;
const nestedMarkers = /^(?:[ \t]*(?:>|[-+*][ \t]|\d{1,9}[.)][ \t])){11}/m;

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

export function remarkDialect(this: Processor): Transformer<Root> {
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
  return (tree, file) => {
    guard(tree, String(file));
  };
}

const dialectParser = unified().use(remarkParse).use(remarkDialect).freeze();
const dialectSerializer = unified().use(remarkStringify).use(remarkDialect).freeze();
const plainParser = unified().use(remarkParse).use(remarkGfmParts).freeze();

export function nestsTooDeep(markdown: string): boolean {
  return nestedMarkers.test(markdown);
}

export function parseMarkdown(markdown: string): Root {
  const tree: Root = nestsTooDeep(markdown)
    ? { type: 'root', children: [] }
    : dialectParser.parse(markdown);
  return guard(tree, markdown);
}

export function stringifyMarkdown(tree: Root): string {
  return dialectSerializer.stringify(tree);
}

function guard(tree: Root, source: string): Root {
  if (nestsTooDeep(source) || deeperThan(tree, maxDepth)) {
    tree.children = [{ type: 'code', value: source }];
  }
  return tree;
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
