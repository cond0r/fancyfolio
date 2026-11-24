import { isColor } from '../dialect.ts';
import type { Block, Fail, Mark, MarkType, Registered, Registry, Span } from './types.ts';

const order: readonly string[] = [
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'highlight',
  'color',
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
  if (mark.type !== 'color' && mark.color !== undefined) return 'colour on a non-colour mark';
  if (mark.type === 'color' && !isColor(mark.color)) return 'colour off the palette';
  if (mark.type !== 'link') return mark.href === undefined ? undefined : 'href on a non-link mark';
  if (mark.href === undefined || registry.safeHref?.(mark.href) !== true) return 'unsafe link';
  return undefined;
}

const escapable = /[[\\\]]/;
const maxLabelDepth = 32;
const maxLabelEscapes = 999;

function closesLabel(text: string, marks: readonly Mark[], color: Mark): boolean {
  const cuts = new Set([color.from, color.to]);
  for (const { from, to } of marks) {
    for (const at of [from, to]) if (at > color.from && at < color.to) cuts.add(at);
  }
  const sorted = [...cuts].toSorted((a, b) => a - b);
  let depth = 0;
  let escapes = 0;
  for (const [index, from] of sorted.slice(0, -1).entries()) {
    const to = sorted[index + 1] ?? from;
    if (marks.some((mark) => mark.type === 'link' && (mark.from === from || mark.to === from))) {
      if (depth !== 0) return true;
      escapes = 0;
    }
    const code = marks.some((mark) => mark.type === 'code' && mark.from <= from && to <= mark.to);
    for (let at = from; at < to; at += 1) {
      const char = text[at] ?? '';
      if (!code) escapes += escapable.test(char) ? 1 : 0;
      else if (char === '\\' && at + 1 < to && escapable.test(text[at + 1] ?? '')) {
        escapes += 1;
        at += 1;
      } else if (char === '[') depth += 1;
      else if (char === ']') depth -= 1;
      if (depth < 0 || depth > maxLabelDepth || escapes > maxLabelEscapes) return true;
    }
  }
  return depth !== 0;
}

function canonical(text: string, marks: readonly Mark[], fail?: Fail): Mark[] {
  const sorted = marks.toSorted((a, b) => rank(a) - rank(b) || a.from - b.from || a.to - b.to);
  const out: Mark[] = [];
  for (const mark of sorted) {
    const last = out.at(-1);
    if (last === undefined || last.type !== mark.type || mark.from > last.to) out.push(mark);
    else if (last.href === mark.href && last.color === mark.color)
      out[out.length - 1] = { ...last, to: Math.max(last.to, mark.to) };
    else if (mark.from === last.to) out.push(mark);
    else fail?.(mark.type === 'link' ? 'links overlap' : 'colours overlap');
  }
  return out.filter((mark) => {
    const breaks = mark.type === 'color' && closesLabel(text, out, mark);
    if (breaks) fail?.('a colour label the parser cannot close');
    return !breaks;
  });
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
  return canonical(text, kept, fail);
}

export function marksIn(block: Block, field: string): readonly Mark[] {
  return block.marks !== undefined && Object.hasOwn(block.marks, field) ? block.marks[field] : [];
}

const endInclusive: readonly MarkType[] = ['bold', 'italic', 'strike', 'highlight', 'color'];

export function typedMarks(block: Block, field: string, offset: number, text: string): Mark[] {
  const lines = text.split('\n');
  return marksIn(block, field).flatMap(({ from, to, ...mark }) => {
    const at = endInclusive.includes(mark.type) ? offset <= to : offset < to;
    if (from >= offset || !at) return [];
    if (mark.type !== 'code') return [{ ...mark, from: 0, to: text.length }];
    let start = 0;
    return lines.flatMap((line) => {
      const span = { ...mark, from: start, to: start + line.length };
      start += line.length + 1;
      return line === '' ? [] : [span];
    });
  });
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
