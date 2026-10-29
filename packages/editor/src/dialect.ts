import type { Nodes, Parents, Root } from 'mdast';
import {
  type ContainerDirective,
  directiveFromMarkdown,
  directiveToMarkdown,
  type LeafDirective,
} from 'mdast-util-directive';
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
import type { Construct, DialectFallback, State } from './types.ts';

const maxDepth = 100;
const maxColumn = 100;
const maxImageStarts = 500;
const maxFenceLines = 10;
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
    gfmTableToMarkdown({ tablePipeAlign: false }),
    gfmTaskListItemToMarkdown(),
  ];
}

const misorderedMessage = 'remarkDialect must be used after remark-parse';
const guardedParsers = new WeakSet<object>();

export function remarkDialect(this: Processor): Transformer<Root> {
  remarkGfmParts.call(this);
  const data = this.data();
  data.settings = { ...data.settings, bullet: '-', emphasis: '*', rule: '-' };
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
  return () => {
    if (this.parser !== undefined && !guardedParsers.has(this.parser)) {
      throw new Error(misorderedMessage);
    }
  };
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
  const fenceLines = new WeakMap<object, Set<number>>();
  const fenceCount: Construct = {
    name: 'dialectFenceCount',
    tokenize(effects, _ok, nok) {
      let colons = 0;
      const count: State = (code) => {
        if (code === 58) {
          effects.consume(code);
          colons += 1;
          return count;
        }
        if (colons >= 3) {
          const lines = fenceLines.get(this.parser) ?? new Set<number>();
          lines.add(this.now().line);
          fenceLines.set(this.parser, lines);
          if (lines.size > maxFenceLines) throw new DialectGuardStop('directives');
        }
        return nok(code);
      };
      return (code) => {
        effects.enter('data');
        return count(code);
      };
    },
  };
  const data = this.data();
  data.micromarkExtensions = [
    ...(data.micromarkExtensions ?? []),
    { flow: { 58: fenceCount } },
    {
      document: Object.fromEntries(
        containerStarts.map((code): [number, Construct] => [code, columnGuard]),
      ),
    },
    { text: { 33: imageBudget } },
  ];
  const parse = this.parser;
  if (parse === undefined) {
    Object.defineProperty(this, 'parser', {
      configurable: true,
      enumerable: true,
      get: () => misordered,
      set: () => undefined,
    });
    return;
  }
  const guarded: typeof parse = (document, file) => {
    try {
      const tree = parse(document, file);
      if (!isRoot(tree)) return tree;
      const reason = exceeds(tree, document.length);
      return reason === undefined ? tree : fallback(document, reason);
    } catch (error) {
      if (error instanceof DialectGuardStop) return fallback(document, error.reason);
      throw error;
    }
  };
  guardedParsers.add(guarded);
  this.parser = guarded;
}

function misordered(): never {
  throw new Error(misorderedMessage);
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
        value: document.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'),
        data: { dialectFallback: reason },
      },
    ],
  };
}

const dialectParser = unified().use(remarkParse).use(remarkDialect).freeze();
const dialectSerializer = unified().use(remarkStringify).use(remarkDialect).freeze();

export function parseMarkdown(markdown: string): Root {
  return dialectParser.parse(markdown);
}

export function stringifyMarkdown(tree: Root): string {
  const [only] = tree.children;
  if (tree.children.length === 1 && only?.type === 'code' && only.data?.dialectFallback) {
    return only.value;
  }
  return dialectSerializer.stringify(mergeText(tree));
}

function mergeText<T extends Nodes>(node: T): T {
  if (!('children' in node)) return node;
  const children: Nodes[] = [];
  for (const child of node.children as Nodes[]) {
    const copy = mergeText(child);
    if ((copy.type === 'text' || copy.type === 'html') && copy.value === '') continue;
    const last = children.at(-1);
    if (copy.type === 'text' && last?.type === 'text') {
      children[children.length - 1] = { type: 'text', value: last.value + copy.value };
    } else {
      children.push(copy);
    }
  }
  return { ...node, children };
}

function exceeds(tree: Root, characters: number): DialectFallback | undefined {
  let cells = 0;
  let expansion = 0;
  const definitions = new Map<string, number>();
  const references: string[] = [];
  const stack: [Nodes, number][] = [[tree, 0]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [node, depth] = next;
    if (depth > maxDepth) return 'depth';
    if (node.type === 'table') {
      const widest = node.children.reduce((most, row) => Math.max(most, row.children.length), 0);
      cells += node.children.length * Math.max(node.align?.length ?? 0, widest);
      if (cells > characters) return 'cells';
    }
    if (node.type === 'definition') {
      definitions.set(node.identifier, node.url.length + (node.title?.length ?? 0));
    } else if (node.type === 'linkReference' || node.type === 'imageReference') {
      references.push(node.identifier);
    }
    if ('children' in node) {
      const children: Nodes[] = node.children;
      for (const child of children) stack.push([child, depth + 1]);
    }
  }
  for (const identifier of references) expansion += definitions.get(identifier) ?? 0;
  return expansion > characters ? 'references' : undefined;
}

export function remarkDirectiveAllowlist(options: { allow: readonly string[] }): Transformer<Root> {
  const allow = new Set(options.allow);
  return (tree) => replaceUnknown(tree, allow);
}

function replaceUnknown(parent: Parents, allow: Set<string>) {
  const children: Nodes[] = parent.children;
  const replaced = children.flatMap((child): Nodes[] => {
    if (child.type === 'leafDirective' && !allow.has(child.name)) {
      return [textParagraph(openingLine(child))];
    }
    if (child.type === 'containerDirective' && !allow.has(child.name)) {
      replaceUnknown(child, allow);
      const open = openingLine(child);
      const content = child.children.filter((node: Nodes) => !isLabel(node));
      return [textParagraph(open), ...content, textParagraph(':::')];
    }
    if ('children' in child) replaceUnknown(child, allow);
    return [child];
  });
  (parent as { children: Nodes[] }).children = replaced;
}

function openingLine(node: LeafDirective | ContainerDirective): string {
  const { type, name, attributes } = node;
  const label =
    node.type === 'leafDirective'
      ? node.children
      : node.children.filter((child: Nodes) => isLabel(child));
  const copy = { type, name, attributes, children: label } as LeafDirective | ContainerDirective;
  return stringifyMarkdown({ type: 'root', children: [copy] }).split('\n')[0] ?? '';
}

function isLabel(node: Nodes): boolean {
  return (
    node.data !== undefined && 'directiveLabel' in node.data && node.data.directiveLabel === true
  );
}

function textParagraph(value: string): Nodes {
  return { type: 'paragraph', children: [{ type: 'text', value }] };
}
