import type { Heading, Nodes, Paragraph, Root, RootContent, Text } from 'mdast';
import { parseMarkdown, stringifyMarkdown } from '../dialect.ts';
import { docOf, isCanonicalText, isSameKind } from './model.ts';
import type {
  Block,
  BlockId,
  BlockKind,
  Doc,
  HeadingLevel,
  Part,
  Read,
  SaveResult,
  Source,
  Verdict,
} from './types.ts';

const reads = new WeakMap<Source, Read>();
const rawTypes = new WeakMap<Block, readonly string[]>();
const canonicals = new WeakMap<Block, string>();

function textOf(node: Paragraph | Heading): string | undefined {
  const parts = node.children.filter((child): child is Text => child.type === 'text');
  return parts.length === node.children.length
    ? parts.map((part) => part.value).join('')
    : undefined;
}

function modelled(node: RootContent | undefined): (BlockKind & { text: string }) | undefined {
  if (node?.type !== 'paragraph' && node?.type !== 'heading') return undefined;
  const text = textOf(node);
  if (text === undefined || !isCanonicalText(text)) return undefined;
  return node.type === 'heading'
    ? { type: 'heading', level: node.depth as HeadingLevel, text }
    : { type: 'paragraph', text };
}

function span(node: Nodes): { start: number; end: number } {
  const { start, end } = node.position ?? {};
  if (start?.offset === undefined || end?.offset === undefined) {
    throw new Error(`markdown node ${node.type} has no source position`);
  }
  return { start: start.offset, end: end.offset };
}

function isGuarded(tree: Root): boolean {
  const [only] = tree.children;
  return tree.children.length === 1 && only?.type === 'code' && !!only.data?.dialectFallback;
}

function uniqueIds(newId: () => BlockId): () => BlockId {
  const issued = new Set<BlockId>();
  return () => {
    const id = newId();
    if (id === '' || issued.has(id)) {
      throw new RangeError('load refused: newId returned an empty or repeated id');
    }
    issued.add(id);
    return id;
  };
}

export function load(markdown: string, newId: () => BlockId): Doc {
  const nextId = uniqueIds(newId);
  const lf = markdown.replace(/\r\n?/g, '\n');
  if (!isCanonicalText(lf)) throw new RangeError('load refused: the body is not canonical text');
  const body = lf.replace(/^\uFEFF/, '');
  const tree = parseMarkdown(lf);
  if (isGuarded(tree)) {
    const block: Block = { id: nextId(), type: 'raw', text: body };
    const source: Source = { markdown: body, afterId: null, gap: '', trailing: '' };
    return docOf([block], new Map([[block.id, source]]));
  }
  const blocks: Block[] = [];
  const sources = new Map<BlockId, Source>();
  let end = 0;
  for (const [index, node] of tree.children.entries()) {
    const at = span(node);
    const lineStart = Math.max(end, body.lastIndexOf('\n', at.start - 1) + 1);
    const slice = body.slice(lineStart, at.end);
    const read = modelled(node);
    const block: Block = { ...(read ?? { type: 'raw', text: slice }), id: nextId() };
    const source: Source = {
      markdown: slice,
      afterId: blocks.at(-1)?.id ?? null,
      gap: body.slice(end, lineStart),
      ...(index === tree.children.length - 1 && { trailing: body.slice(at.end) }),
    };
    reads.set(source, read ?? null);
    if (read === undefined) rawTypes.set(block, [node.type]);
    blocks.push(block);
    sources.set(block.id, source);
    end = at.end;
  }
  if (blocks.length === 0) return docOf([{ id: nextId(), type: 'paragraph', text: '' }]);
  return docOf(blocks, sources);
}

function written(block: Block): string {
  const children: Text[] = block.text === '' ? [] : [{ type: 'text', value: block.text }];
  const node: Paragraph | Heading =
    block.type === 'heading'
      ? { type: 'heading', depth: block.level, children }
      : { type: 'paragraph', children };
  return stringifyMarkdown({ type: 'root', children: [node] })
    .replace(/\n$/, '')
    .replace(/(?<=::):/g, '\\:');
}

function matches(read: Read | undefined, block: Block): boolean {
  return read != null && isSameKind(read, block) && read.text === block.text;
}

function readsBack(block: Block, nodes: readonly RootContent[]): boolean {
  return matches(nodes.length === 1 ? modelled(nodes[0]) : undefined, block);
}

function reference(char: string): string {
  return `&#${char.charCodeAt(0)};`;
}

function escaped(block: Block): string {
  const lines = block.text
    .split('\n')
    .map((line) =>
      line
        .replace(/[!-/:-@[-`{-~]/g, '\\$&')
        .replace(/^[\t \uFEFF]+|[\t ]+$/g, (edge) => [...edge].map(reference).join('')),
    );
  if (block.type === 'heading') {
    const text = lines.join('&#10;');
    return `${'#'.repeat(block.level)}${text === '' ? '' : ` ${text}`}`;
  }
  return lines.reduce((joined, line, index) => {
    const blank = line === '' || lines[index - 1] === '';
    return index === 0 ? line : `${joined}${blank ? '&#10;' : '\n'}${line}`;
  }, '');
}

function canonical(block: Block): string {
  if (block.type === 'raw') return block.text;
  const cached = canonicals.get(block);
  if (cached !== undefined) return cached;
  const markdown = written(block);
  const chosen =
    markdown === '' || readsBack(block, parseMarkdown(markdown).children)
      ? markdown
      : escaped(block);
  canonicals.set(block, chosen);
  return chosen;
}

function parsedAlone(markdown: string): Root {
  // the parser drops a BOM only at the start of the body, where save never writes one
  return parseMarkdown(markdown.startsWith('\uFEFF') ? `\n${markdown}` : markdown);
}

function sourceRead(source: Source): Read {
  const known = reads.get(source);
  if (known !== undefined) return known;
  const nodes = parsedAlone(source.markdown).children;
  const read = (nodes.length === 1 ? modelled(nodes[0]) : undefined) ?? null;
  reads.set(source, read);
  return read;
}

function typesAlone(block: Block): readonly string[] {
  const known = rawTypes.get(block);
  if (known !== undefined) return known;
  const types = parsedAlone(block.text).children.map((node) => node.type);
  rawTypes.set(block, types);
  return types;
}

function writing(
  block: Block,
  source: Source | undefined,
  escaping: boolean,
): { markdown: string; verbatim: boolean } {
  if (block.type === 'raw')
    return { markdown: block.text, verbatim: block.text === source?.markdown };
  if (escaping) return { markdown: escaped(block), verbatim: false };
  if (source !== undefined && matches(sourceRead(source), block)) {
    return { markdown: source.markdown, verbatim: true };
  }
  return { markdown: canonical(block), verbatim: false };
}

function gapBefore(
  before: Part | undefined,
  source: Source | undefined,
  verbatim: boolean,
): string {
  if (before === undefined) return source?.afterId === null ? source.gap : '';
  if (source === undefined) return '\n\n';
  const kept = /\n[\t ]*\n/.test(source.gap) || (before.verbatim && verbatim);
  return source.afterId === before.block.id && kept ? source.gap : '\n\n';
}

function layout(doc: Doc, escaping: ReadonlySet<BlockId>): { parts: Part[]; exact: boolean } {
  const parts: Part[] = [];
  let exact = true;
  let previous: BlockId | null = null;
  for (const id of doc.ids) {
    const block = doc.blocks.get(id);
    if (block === undefined) throw new Error(`block ${id} is missing`);
    const source = doc.sources.get(id);
    const { markdown, verbatim } = writing(block, source, escaping.has(id));
    exact &&= verbatim && source?.afterId === previous;
    previous = id;
    if (/^[\t\n ]*$/.test(markdown)) continue;
    const gap = gapBefore(parts.at(-1), source, verbatim);
    const bom = gap === '' && markdown.startsWith('\uFEFF');
    parts.push({ block, gap: bom ? '\n' : gap, markdown, verbatim });
  }
  return { parts, exact };
}

function joined(parts: readonly Part[], trailing: string | undefined): string {
  const body = parts.map((part) => part.gap + part.markdown).join('');
  if (trailing !== undefined) return body + trailing;
  return body === '' || body.endsWith('\n') ? body : `${body}\n`;
}

function placed(parts: readonly Part[], tree: Root): RootContent[][] | BlockId {
  let at = 0;
  const bounds = parts.map((part) => {
    const start = at + part.gap.length;
    at = start + part.markdown.length;
    return { start, end: at };
  });
  const found: RootContent[][] = parts.map(() => []);
  let index = 0;
  let floor = 0;
  for (const node of tree.children) {
    const { end } = span(node);
    const start = Math.max(floor, span(node).start);
    floor = end;
    while ((bounds[index + 1]?.start ?? Number.POSITIVE_INFINITY) <= start) index += 1;
    const bound = bounds[index];
    if (start < bound.start) return parts[index].block.id;
    if (end > bound.end) {
      const reached = bounds.findLastIndex((each) => each.start < end);
      return parts[Math.min(Math.max(reached, index + 1), parts.length - 1)].block.id;
    }
    found[index].push(node);
  }
  return found;
}

function verdict(parts: readonly Part[], trailing: string | undefined): Verdict {
  const markdown = joined(parts, trailing);
  if (parts.length === 0) return { ok: true, markdown };
  const tree = parseMarkdown(markdown);
  if (isGuarded(tree)) {
    const [only] = parts;
    return parts.length === 1 && only?.block.type === 'raw'
      ? { ok: true, markdown }
      : { ok: false, reason: 'guard' };
  }
  const found = placed(parts, tree);
  if (typeof found === 'string') return { ok: false, reason: 'misread', blockId: found };
  const unread = new Set<BlockId>();
  for (const [index, { block }] of parts.entries()) {
    const nodes = found[index];
    if (block.type !== 'raw') {
      if (!readsBack(block, nodes)) unread.add(block.id);
      continue;
    }
    const types = typesAlone(block);
    if (nodes.length !== types.length || nodes.some((node, at) => node.type !== types[at])) {
      return { ok: false, reason: 'misread', blockId: block.id };
    }
  }
  return unread.size === 0 ? { ok: true, markdown } : { ok: false, reason: 'unread', ids: unread };
}

export function save(doc: Doc): SaveResult {
  const trailing = doc.sources.get(doc.ids.at(-1) ?? '')?.trailing;
  const { parts, exact } = layout(doc, new Set());
  if (exact && trailing !== undefined) return { ok: true, markdown: joined(parts, trailing) };
  const first = verdict(parts, trailing);
  if (first.ok || first.reason !== 'unread') return first;
  const second = verdict(layout(doc, first.ids).parts, trailing);
  if (second.ok || second.reason !== 'unread') return second;
  const [blockId] = second.ids;
  return { ok: false, reason: 'misread', blockId };
}
