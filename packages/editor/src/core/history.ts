import type { History, Op, Step, Travel } from './types.ts';

export const emptyHistory: History = { done: [], undone: [], sealed: true };

const typingPause = 1000;
const stepSpan = 2000;
const maxSteps = 500;

function continued(step: Step | undefined, ops: readonly Op[], at: number): Step | undefined {
  const [last] = step?.ops ?? [];
  const [op] = ops;
  if (step === undefined || step.ops.length !== 1 || ops.length !== 1) return undefined;
  if (last?.kind !== 'insertText' || op?.kind !== 'insertText') return undefined;
  if (last.blockId !== op.blockId || last.field !== op.field) return undefined;
  if (op.offset !== last.offset + last.text.length || last.text.includes('\n')) return undefined;
  if (Math.abs(at - step.at) > typingPause || Math.abs(at - step.started) > stepSpan) {
    return undefined;
  }
  const { blockId, field, offset } = last;
  const text = last.text + op.text;
  return {
    ops: [{ kind: 'insertText', blockId, field, offset, text }],
    inverses: [{ kind: 'deleteText', blockId, field, from: offset, to: offset + text.length }],
    started: step.started,
    at,
  };
}

export function record(
  history: History,
  ops: readonly Op[],
  inverses: readonly Op[],
  at: number,
): History {
  const typed = history.sealed ? undefined : continued(history.done.at(-1), ops, at);
  const done = typed
    ? [...history.done.slice(0, -1), typed]
    : [...history.done.slice(1 - maxSteps), { ops, inverses, started: at, at }];
  return { done, undone: [], sealed: false };
}

export function undo(history: History): Travel | undefined {
  const step = history.done.at(-1);
  if (step === undefined) return undefined;
  return {
    history: { done: history.done.slice(0, -1), undone: [...history.undone, step], sealed: true },
    ops: step.inverses.toReversed(),
    inverses: step.ops.toReversed(),
  };
}

export function redo(history: History): Travel | undefined {
  const step = history.undone.at(-1);
  if (step === undefined) return undefined;
  return {
    history: { done: [...history.done, step], undone: history.undone.slice(0, -1), sealed: true },
    ops: step.ops,
    inverses: step.inverses,
  };
}
