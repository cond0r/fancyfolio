import type { Nodes, Root, RootContent } from 'mdast';
import { parseMarkdown, stringifyMarkdown } from '../dialect.ts';
import { docOf, isCanonicalText, isRaw, sameJson } from './model.ts';
import { builtins, fieldsFor, propsFor } from './registry.ts';
import type {
  AnyComponent,
  Block,
  BlockId,
  Doc,
  Part,
  Read,
  Registry,
  SaveResult,
  Source,
  Verdict,
} from './types.ts';

const reads = new WeakMap<Source, Read>();
const rawTypes = new WeakMap<Block, readonly string[]>();
const canonicals = new WeakMap<Block, string>();

function matchOf(node: RootContent): string {
  return node.type === 'leafDirective' || node.type === 'containerDirective'
    ? `${node.type}:${node.name}`
    : node.type;
}

function modelled(
  node: RootContent | undefined,
  registry: Registry,
): Exclude<Read, null> | undefined {
  if (node === undefined) return undefined;
  const component = registry.matches.get(matchOf(node));
  if (component === undefined) return undefined;
  try {
    const read = component.markdown.read(node);
    if (read === undefined) return undefined;
    const props = propsFor(component, read.props);
    const fields = fieldsFor(component, read.fields);
    return props === undefined || fields === undefined
      ? undefined
      : { type: component.name, props, fields };
  } catch {
    return undefined;
  }
}

function rawBlock(id: BlockId, text: string): Block {
  return { id, type: 'raw', props: {}, fields: { text } };
}

function codecOf(block: Block, registry: Registry): AnyComponent['markdown'] {
  const codec = registry.components.get(block.type)?.markdown;
  if (codec === undefined) throw new Error(`block type ${block.type} has no markdown codec`);
  return codec;
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

export function load(markdown: string, newId: () => BlockId, registry: Registry = builtins): Doc {
  const nextId = uniqueIds(newId);
  const lf = markdown.replace(/\r\n?/g, '\n');
  if (!isCanonicalText(lf)) throw new RangeError('load refused: the body is not canonical text');
  const body = lf.replace(/^\uFEFF/, '');
  const tree = parseMarkdown(lf);
  if (isGuarded(tree)) {
    const block = rawBlock(nextId(), body);
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
    const read = modelled(node, registry);
    const block: Block = read === undefined ? rawBlock(nextId(), slice) : { ...read, id: nextId() };
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
  if (blocks.length === 0) {
    return docOf([{ id: nextId(), type: 'paragraph', props: {}, fields: { text: '' } }]);
  }
  return docOf(blocks, sources);
}

function written(block: Block, registry: Registry): string {
  const node = codecOf(block, registry).write(block);
  return stringifyMarkdown({ type: 'root', children: [node] })
    .replace(/\n$/, '')
    .replace(/(?<=::):/g, '\\:');
}

function matches(read: Read | undefined, block: Block): boolean {
  return (
    read != null &&
    read.type === block.type &&
    sameJson(read.props, block.props) &&
    sameJson(read.fields, block.fields)
  );
}

function readsBack(block: Block, nodes: readonly RootContent[], registry: Registry): boolean {
  return matches(nodes.length === 1 ? modelled(nodes[0], registry) : undefined, block);
}

function canonical(block: Block, registry: Registry): string {
  if (isRaw(block.type)) return block.fields.text;
  const cached = canonicals.get(block);
  if (cached !== undefined) return cached;
  const markdown = written(block, registry);
  const chosen =
    markdown === '' || readsBack(block, parseMarkdown(markdown).children, registry)
      ? markdown
      : (codecOf(block, registry).escaped?.(block) ?? markdown);
  canonicals.set(block, chosen);
  return chosen;
}

function parsedAlone(markdown: string): Root {
  // the parser drops a BOM only at the start of the body, where save never writes one
  return parseMarkdown(markdown.startsWith('\uFEFF') ? `\n${markdown}` : markdown);
}

function sourceRead(source: Source, registry: Registry): Read {
  const known = reads.get(source);
  if (known !== undefined) return known;
  const nodes = parsedAlone(source.markdown).children;
  const read = (nodes.length === 1 ? modelled(nodes[0], registry) : undefined) ?? null;
  reads.set(source, read);
  return read;
}

function typesAlone(block: Block): readonly string[] {
  const known = rawTypes.get(block);
  if (known !== undefined) return known;
  const types = parsedAlone(block.fields.text).children.map((node) => node.type);
  rawTypes.set(block, types);
  return types;
}

function writing(
  block: Block,
  source: Source | undefined,
  escaping: boolean,
  registry: Registry,
): { markdown: string; verbatim: boolean } {
  if (isRaw(block.type)) {
    return { markdown: block.fields.text, verbatim: block.fields.text === source?.markdown };
  }
  const escaped = escaping ? codecOf(block, registry).escaped?.(block) : undefined;
  if (escaped !== undefined) return { markdown: escaped, verbatim: false };
  if (source !== undefined && matches(sourceRead(source, registry), block)) {
    return { markdown: source.markdown, verbatim: true };
  }
  return { markdown: canonical(block, registry), verbatim: false };
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

function layout(
  doc: Doc,
  escaping: ReadonlySet<BlockId>,
  registry: Registry,
): { parts: Part[]; exact: boolean } {
  const parts: Part[] = [];
  let exact = true;
  let previous: BlockId | null = null;
  for (const id of doc.ids) {
    const block = doc.blocks.get(id);
    if (block === undefined) throw new Error(`block ${id} is missing`);
    const source = doc.sources.get(id);
    const { markdown, verbatim } = writing(block, source, escaping.has(id), registry);
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

function verdict(
  parts: readonly Part[],
  trailing: string | undefined,
  registry: Registry,
): Verdict {
  const markdown = joined(parts, trailing);
  if (parts.length === 0) return { ok: true, markdown };
  const tree = parseMarkdown(markdown);
  if (isGuarded(tree)) {
    const [only] = parts;
    return parts.length === 1 && only !== undefined && isRaw(only.block.type)
      ? { ok: true, markdown }
      : { ok: false, reason: 'guard' };
  }
  const found = placed(parts, tree);
  if (typeof found === 'string') return { ok: false, reason: 'misread', blockId: found };
  const unread = new Set<BlockId>();
  for (const [index, { block }] of parts.entries()) {
    const nodes = found[index];
    if (!isRaw(block.type)) {
      if (!readsBack(block, nodes, registry)) unread.add(block.id);
      continue;
    }
    const types = typesAlone(block);
    if (nodes.length !== types.length || nodes.some((node, at) => node.type !== types[at])) {
      return { ok: false, reason: 'misread', blockId: block.id };
    }
  }
  return unread.size === 0 ? { ok: true, markdown } : { ok: false, reason: 'unread', ids: unread };
}

export function save(doc: Doc, registry: Registry = builtins): SaveResult {
  const trailing = doc.sources.get(doc.ids.at(-1) ?? '')?.trailing;
  const { parts, exact } = layout(doc, new Set(), registry);
  if (exact && trailing !== undefined) return { ok: true, markdown: joined(parts, trailing) };
  const first = verdict(parts, trailing, registry);
  if (first.ok || first.reason !== 'unread') return first;
  const second = verdict(layout(doc, first.ids, registry).parts, trailing, registry);
  if (second.ok || second.reason !== 'unread') return second;
  const [blockId] = second.ids;
  return { ok: false, reason: 'misread', blockId };
}
