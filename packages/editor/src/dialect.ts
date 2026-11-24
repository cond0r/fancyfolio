import type { Nodes, Parents, Root } from 'mdast';
import {
  type ContainerDirective,
  directiveFromMarkdown,
  directiveToMarkdown,
  type LeafDirective,
  type TextDirective,
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
import type {
  Code,
  Color,
  Construct,
  DialectFallback,
  Event,
  Handle,
  Resolver,
  State,
  Token,
  TokenizeContext,
  Unsafe,
} from './types.ts';

export const colors: { readonly [C in Color]: string } = Object.freeze({
  red: 'ff-color-red',
  orange: 'ff-color-orange',
  green: 'ff-color-green',
  blue: 'ff-color-blue',
  purple: 'ff-color-purple',
});

export function isColor(value: unknown): value is Color {
  return typeof value === 'string' && Object.hasOwn(colors, value);
}

export function colorOf({ name, attributes }: TextDirective): Color | undefined {
  const tone = attributes?.tone;
  const only = attributes != null && Object.keys(attributes).length === 1;
  return name === 'color' && only && isColor(tone) ? tone : undefined;
}

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

const equals = 61;

function group(code: Code): 1 | 2 | undefined {
  if (code === null || code < 0) return 1;
  const char = String.fromCharCode(code);
  if (/\s/u.test(char)) return 1;
  return /[\p{P}\p{S}]/u.test(char) ? 2 : undefined;
}

function spliced<T>(list: T[], start: number, remove: number, items: readonly T[]): void {
  list.splice(start, remove);
  for (let at = 0; at < items.length; at += 10_000) {
    list.splice(start + at, 0, ...items.slice(at, at + 10_000));
  }
}

function resolvedInside(events: Event[], context: TokenizeContext): Event[] {
  const called = new Set<Resolver>();
  let resolved = events;
  for (const { resolveAll } of context.parser.constructs.insideSpan.null ?? []) {
    if (resolveAll === undefined || called.has(resolveAll)) continue;
    called.add(resolveAll);
    resolved = resolveAll(resolved, context);
  }
  return resolved;
}

function opens([kind, token]: Event): boolean {
  return kind === 'exit' && token.type === 'highlightSequenceTemporary' && token._open === true;
}

const resolveHighlights: Resolver = (events, context) => {
  for (let index = 0; index < events.length; index += 1) {
    const [kind, close] = events[index];
    if (kind !== 'enter' || close.type !== 'highlightSequenceTemporary' || !close._close) continue;
    let open = index - 1;
    while (open >= 0 && !opens(events[open])) open -= 1;
    if (open < 0) continue;
    const opener = events[open][1];
    opener.type = 'highlightSequence';
    close.type = 'highlightSequence';
    const whole: Token = { type: 'highlight', start: { ...opener.start }, end: { ...close.end } };
    const text: Token = {
      type: 'highlightText',
      start: { ...opener.end },
      end: { ...close.start },
    };
    const replaced: Event[] = [
      ['enter', whole, context],
      ['enter', opener, context],
      ['exit', opener, context],
      ['enter', text, context],
      ...resolvedInside(events.slice(open + 1, index), context),
      ['exit', text, context],
      ['enter', close, context],
      ['exit', close, context],
      ['exit', whole, context],
    ];
    spliced(events, open - 1, index - open + 3, replaced);
    index = open + replaced.length - 2;
  }
  for (const [, token] of events) {
    if (token.type === 'highlightSequenceTemporary') token.type = 'data';
  }
  return events;
};

const highlight: Construct = {
  name: 'highlight',
  tokenize(effects, ok, nok) {
    const before = this.previous;
    let size = 0;
    const more: State = (code) => {
      if (code === equals) {
        if (size > 1) return nok(code);
        effects.consume(code);
        size += 1;
        return more;
      }
      if (size < 2) return nok(code);
      const token = effects.exit('highlightSequenceTemporary');
      const [left, right] = [group(before), group(code)];
      token._open = !right || (right === 2 && Boolean(left));
      token._close = !left || (left === 2 && Boolean(right));
      return ok(code);
    };
    return (code) => {
      if (before === equals && this.events.at(-1)?.[1].type !== 'characterEscape') return nok(code);
      effects.enter('highlightSequenceTemporary');
      return more(code);
    };
  },
  resolveAll: resolveHighlights,
};

const handleHighlight: Handle = (node, _parent, state, info) => {
  const tracker = state.createTracker(info);
  let value = tracker.move('==');
  value += state.containerPhrasing(node, { ...tracker.current(), before: value, after: '=' });
  return value + tracker.move('==');
};

const highlightHandler = Object.assign(handleHighlight, {
  peek: () => '=',
  attention: () => ({ construct: 'phrasing', markers: ['='], sizes: [2] }),
});

const outsideText: Unsafe['notInConstruct'] = [
  'autolink',
  'destinationLiteral',
  'destinationRaw',
  'reference',
  'titleQuote',
  'titleApostrophe',
];

const markUnsafe: Unsafe[] = [
  { character: '=', after: '(?==)|(?<==.)', inConstruct: 'phrasing', notInConstruct: outsideText },
  { character: ':', after: 'color\\[', inConstruct: 'phrasing', notInConstruct: outsideText },
];

const [directiveText] = [directive().text?.[58]].flat();
const colorOpener = ':color[';

const opensColor: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    let at = 0;
    const next: State = (code) => {
      if (at === colorOpener.length) return ok(code);
      if (code !== colorOpener.charCodeAt(at)) return nok(code);
      effects.consume(code);
      at += 1;
      return next;
    };
    return (code) => {
      effects.enter('data');
      return next(code);
    };
  },
};

const colorDirective: Construct = {
  name: 'dialectColor',
  previous: directiveText?.previous,
  tokenize(effects, ok, nok) {
    if (directiveText === undefined) return nok;
    const start = this.events.length;
    const labelled: State = (code) =>
      this.events.slice(start).some(([, token]) => token.type === 'directiveTextLabel')
        ? ok(code)
        : nok(code);
    return effects.check(
      opensColor,
      directiveText.tokenize.call(this, effects, labelled, nok),
      nok,
    );
  },
};

function remarkMarks(this: Processor) {
  const data = this.data();
  data.micromarkExtensions = [
    ...(data.micromarkExtensions ?? []),
    {
      text: { [equals]: highlight, 58: colorDirective },
      insideSpan: { null: [highlight] },
      attentionMarkers: { null: [equals] },
    },
  ];
  data.fromMarkdownExtensions = [
    ...(data.fromMarkdownExtensions ?? []),
    {
      canContainEols: ['highlight'],
      enter: {
        highlight(token) {
          this.enter({ type: 'highlight', children: [] }, token);
        },
      },
      exit: {
        highlight(token) {
          this.exit(token);
        },
      },
    },
  ];
  data.toMarkdownExtensions = [
    ...(data.toMarkdownExtensions ?? []),
    {
      handlers: { highlight: highlightHandler },
      unsafe: markUnsafe,
    },
  ];
}

function rendered(parent: Parents): void {
  const children: Nodes[] = parent.children;
  const kept = children.flatMap((child): Nodes[] => {
    if ('children' in child) rendered(child);
    if (child.type === 'highlight') Object.assign(child, { data: { hName: 'mark' } });
    if (child.type !== 'textDirective') return [child];
    const color = colorOf(child);
    if (color === undefined) return child.children;
    Object.assign(child, { data: { hName: 'span', hProperties: { className: [colors[color]] } } });
    return [child];
  });
  (parent as { children: Nodes[] }).children = kept;
}

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
      unsafe: toMarkdown.unsafe?.filter(
        (rule) => rule.afterNode !== undefined || ![rule.inConstruct].flat().includes('phrasing'),
      ),
    },
  ];
  remarkMarks.call(this);
  remarkGuard.call(this);
  return (tree) => {
    if (this.parser !== undefined && !guardedParsers.has(this.parser)) {
      throw new Error(misorderedMessage);
    }
    rendered(tree);
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
