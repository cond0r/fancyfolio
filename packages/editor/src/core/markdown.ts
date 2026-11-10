import type { Html, Nodes, Root, RootContent } from 'mdast';
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
  Reading,
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
  nested = false,
): Reading | undefined {
  if (node === undefined) return undefined;
  const component = registry.matches.get(matchOf(node));
  const names = component?.slots ?? [];
  if (component === undefined || (nested && names.length > 0)) return undefined;
  try {
    const read = component.markdown.read(node);
    if (read === undefined) return undefined;
    const props = propsFor(component, read.props);
    const fields = fieldsFor(component, read.fields);
    if (props === undefined || fields === undefined) return undefined;
    if (names.length === 0) return { type: component.name, props, fields };
    const slots: [string, Reading[]][] = [];
    for (const name of names) {
      const nodes =
        read.slots !== undefined && Object.hasOwn(read.slots, name) ? read.slots[name] : undefined;
      if (!Array.isArray(nodes)) return undefined;
      const children: Reading[] = [];
      for (const child of nodes) {
        const each = modelled(child, registry, true);
        if (each === undefined) return undefined;
        children.push(each);
      }
      slots.push([name, children]);
    }
    return { type: component.name, props, fields, slots: Object.fromEntries(slots) };
  } catch {
    return undefined;
  }
}

function blocksOf({ type, props, fields, slots }: Reading, nextId: () => BlockId): Block[] {
  const block: Block = { id: nextId(), type, props, fields };
  if (slots === undefined) return [block];
  const children: Block[] = [];
  const listed = Object.entries(slots).map(([name, reads]) => {
    const made = reads.map(
      (read): Block => ({ id: nextId(), type: read.type, props: read.props, fields: read.fields }),
    );
    children.push(...made);
    return [name, made.map((child) => child.id)];
  });
  return [{ ...block, slots: Object.fromEntries(listed) }, ...children];
}

function childrenOf(block: Block, slot: string, doc: Doc): Block[] {
  return (block.slots?.[slot] ?? []).map((id) => {
    const child = doc.blocks.get(id);
    if (child === undefined) throw new Error(`block ${id} is missing`);
    return child;
  });
}

function isBlank(markdown: string): boolean {
  return /^[\t\n ]*$/.test(markdown);
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
  const all: Block[] = [];
  const sources = new Map<BlockId, Source>();
  let end = 0;
  for (const [index, node] of tree.children.entries()) {
    const at = span(node);
    const lineStart = Math.max(end, body.lastIndexOf('\n', at.start - 1) + 1);
    const slice = body.slice(lineStart, at.end);
    const read = modelled(node, registry);
    const [block, ...children] =
      read === undefined ? [rawBlock(nextId(), slice)] : blocksOf(read, nextId);
    if (block === undefined) throw new Error('a markdown node has no block');
    const source: Source = {
      markdown: slice,
      afterId: blocks.at(-1)?.id ?? null,
      gap: body.slice(end, lineStart),
      ...(index === tree.children.length - 1 && { trailing: body.slice(at.end) }),
    };
    reads.set(source, read ?? null);
    if (read === undefined) rawTypes.set(block, [node.type]);
    blocks.push(block);
    all.push(block, ...children);
    sources.set(block.id, source);
    end = at.end;
  }
  if (blocks.length === 0) {
    return docOf([{ id: nextId(), type: 'paragraph', props: {}, fields: { text: '' } }]);
  }
  return {
    ids: blocks.map((block) => block.id),
    blocks: new Map(all.map((b) => [b.id, b])),
    sources,
  };
}

function writtenChildren(block: Block, slot: string, doc: Doc, registry: Registry): Block[] {
  return childrenOf(block, slot, doc).filter((child) => !isBlank(canonical(child, doc, registry)));
}

function written(block: Block, doc: Doc, registry: Registry): string {
  const slots = Object.fromEntries(
    Object.keys(block.slots ?? {}).map((slot) => [
      slot,
      writtenChildren(block, slot, doc, registry).map(
        (child): Html => ({ type: 'html', value: canonical(child, doc, registry) }),
      ),
    ]),
  );
  const node = codecOf(block, registry).write(block, slots);
  const markdown = stringifyMarkdown({ type: 'root', children: [node] }).replace(/\n$/, '');
  return node.type === 'leafDirective' || node.type === 'containerDirective'
    ? markdown
    : markdown.replace(/(?<=::):/g, '\\:');
}

function matches(read: Read | undefined, block: Block, doc: Doc, registry: Registry): boolean {
  if (
    read == null ||
    read.type !== block.type ||
    !sameJson(read.props, block.props) ||
    !sameJson(read.fields, block.fields)
  ) {
    return false;
  }
  const slots = Object.keys(block.slots ?? {});
  if (slots.length !== Object.keys(read.slots ?? {}).length) return false;
  return slots.every((slot) => {
    const reads = (
      read.slots !== undefined && Object.hasOwn(read.slots, slot) ? read.slots[slot] : []
    ).filter(
      ({ type, props, fields }) =>
        !isBlank(written({ id: '', type, props, fields }, doc, registry)),
    );
    const children = writtenChildren(block, slot, doc, registry);
    return (
      reads.length === children.length &&
      children.every((child, index) => matches(reads[index], child, doc, registry))
    );
  });
}

function readsBack(
  block: Block,
  nodes: readonly RootContent[],
  doc: Doc,
  registry: Registry,
): boolean {
  return matches(
    nodes.length === 1 ? modelled(nodes[0], registry) : undefined,
    block,
    doc,
    registry,
  );
}

function canonical(block: Block, doc: Doc, registry: Registry): string {
  if (isRaw(block.type)) return block.fields.text;
  const container = block.slots !== undefined;
  const cached = container ? undefined : canonicals.get(block);
  if (cached !== undefined) return cached;
  const markdown = written(block, doc, registry);
  const chosen =
    markdown === '' || readsBack(block, parseMarkdown(markdown).children, doc, registry)
      ? markdown
      : (codecOf(block, registry).escaped?.(block) ?? markdown);
  if (!container) canonicals.set(block, chosen);
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
  doc: Doc,
  registry: Registry,
): { markdown: string; verbatim: boolean } {
  if (isRaw(block.type)) {
    return { markdown: block.fields.text, verbatim: block.fields.text === source?.markdown };
  }
  const escaped = escaping ? codecOf(block, registry).escaped?.(block) : undefined;
  if (escaped !== undefined) return { markdown: escaped, verbatim: false };
  if (source !== undefined && matches(sourceRead(source, registry), block, doc, registry)) {
    return { markdown: source.markdown, verbatim: true };
  }
  return { markdown: canonical(block, doc, registry), verbatim: false };
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
    const { markdown, verbatim } = writing(block, source, escaping.has(id), doc, registry);
    exact &&= verbatim && source?.afterId === previous;
    previous = id;
    if (isBlank(markdown)) continue;
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
  doc: Doc,
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
      if (!readsBack(block, nodes, doc, registry)) unread.add(block.id);
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
  const first = verdict(parts, trailing, doc, registry);
  if (first.ok || first.reason !== 'unread') return first;
  const second = verdict(layout(doc, first.ids, registry).parts, trailing, doc, registry);
  if (second.ok || second.reason !== 'unread') return second;
  const [blockId] = second.ids;
  return { ok: false, reason: 'misread', blockId };
}
