import type { Block, Fail, Mark, MarkType, Registered, Registry, Span } from './types.ts';

const order: readonly string[] = [
  'bold',
  'italic',
  'strike',
  'code',
  'link',
] satisfies readonly MarkType[];

export function isMarkType(type: string): type is MarkType {
  return order.includes(type);
}

function rank(mark: Mark): number {
  return order.indexOf(mark.type);
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function splitsPair(text: string, at: number): boolean {
  return isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));
}

function problem(mark: Mark, text: string, registry: Registry): string | undefined {
  const { from, to } = mark;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length) {
    return 'mark outside the text';
  }
  if (from >= to) return 'empty mark';
  if (splitsPair(text, from) || splitsPair(text, to)) return 'mark inside a surrogate pair';
  if (mark.type === 'code' && text.slice(from, to).includes('\n')) return 'code over a line break';
  if (mark.type !== 'link') return mark.href === undefined ? undefined : 'href on a non-link mark';
  if (mark.href === undefined || registry.safeHref?.(mark.href) !== true) return 'unsafe link';
  return undefined;
}

function canonical(marks: readonly Mark[], fail?: Fail): Mark[] {
  const sorted = marks.toSorted((a, b) => rank(a) - rank(b) || a.from - b.from || a.to - b.to);
  const out: Mark[] = [];
  for (const mark of sorted) {
    const last = out.at(-1);
    if (last === undefined || last.type !== mark.type || mark.from > last.to) out.push(mark);
    else if (last.href === mark.href)
      out[out.length - 1] = { ...last, to: Math.max(last.to, mark.to) };
    else if (mark.from === last.to) out.push(mark);
    else fail?.('links overlap');
  }
  return out;
}

export function marksFor(
  registry: Registry,
  component: Registered,
  field: string,
  text: string,
  marks: readonly Mark[],
  fail?: Fail,
): readonly Mark[] {
  if (marks.length === 0) return [];
  if (!(component.marks ?? []).includes(field)) {
    fail?.('the field takes no marks');
    return [];
  }
  const kept = marks.filter((mark) => {
    const reason = problem(mark, text, registry);
    if (reason !== undefined) fail?.(reason);
    return reason === undefined;
  });
  return canonical(kept, fail);
}

export function marksIn(block: Block, field: string): readonly Mark[] {
  return block.marks !== undefined && Object.hasOwn(block.marks, field) ? block.marks[field] : [];
}

export function withMarks(block: Block, field: string, marks: readonly Mark[]): Block {
  const { marks: all, ...rest } = block;
  const others = Object.entries(all ?? {}).filter(([name]) => name !== field);
  const next = marks.length > 0 ? [...others, [field, marks] as const] : others;
  return next.length > 0 ? { ...rest, marks: Object.fromEntries(next) } : rest;
}

export function shifted(marks: readonly Mark[], by: number): Mark[] {
  return marks.map((mark) => ({ ...mark, from: mark.from + by, to: mark.to + by }));
}

export function sliced(marks: readonly Mark[], from: number, to: number): Mark[] {
  return marks.flatMap((mark) => {
    const [start, end] = [Math.max(mark.from, from), Math.min(mark.to, to)];
    return start < end ? [{ ...mark, from: start - from, to: end - from }] : [];
  });
}

export function inserted(
  marks: readonly Mark[],
  offset: number,
  length: number,
  added: readonly Mark[],
): Mark[] {
  const kept = marks.flatMap((mark) => {
    if (mark.to <= offset) return [mark];
    if (mark.from >= offset) return [{ ...mark, from: mark.from + length, to: mark.to + length }];
    return [
      { ...mark, to: offset },
      { ...mark, from: offset + length, to: mark.to + length },
    ];
  });
  return [...kept, ...shifted(added, offset)];
}

export function deleted(marks: readonly Mark[], from: number, to: number): Mark[] {
  const at = (offset: number) => (offset <= from ? offset : Math.max(from, offset - (to - from)));
  return marks.flatMap((mark) => {
    const [start, end] = [at(mark.from), at(mark.to)];
    return start < end ? [{ ...mark, from: start, to: end }] : [];
  });
}

export function coverage(marks: readonly Mark[], type: MarkType, from: number, to: number): Span[] {
  return marks.flatMap(({ type: each, ...span }) => {
    const [start, end] = [Math.max(span.from, from), Math.min(span.to, to)];
    return each === type && start < end ? [{ ...span, from: start, to: end }] : [];
  });
}

export function covered(
  marks: readonly Mark[],
  type: MarkType,
  from: number,
  to: number,
  spans: readonly Span[],
): Mark[] {
  const outside = marks.flatMap((mark) =>
    mark.type !== type
      ? [mark]
      : [
          { ...mark, to: Math.min(mark.to, from) },
          { ...mark, from: Math.max(mark.from, to) },
        ].filter((part) => part.from < part.to),
  );
  return [...outside, ...spans.map((span) => ({ ...span, type }))];
}
