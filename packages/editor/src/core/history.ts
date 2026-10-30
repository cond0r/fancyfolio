import type { History, Op, Step, Travel } from './types.ts';

export const emptyHistory: History = { done: [], undone: [], sealed: true };

const typingPause = 1000;
const stepSpan = 2000;
const maxSteps = 500;

function continued(step: Step | undefined, op: Op, at: number): Step | undefined {
  const last = step?.op;
  if (step === undefined || last?.kind !== 'insertText' || op.kind !== 'insertText') {
    return undefined;
  }
  if (last.blockId !== op.blockId || last.field !== op.field) return undefined;
  if (op.offset !== last.offset + last.text.length || last.text.includes('\n')) return undefined;
  if (Math.abs(at - step.at) > typingPause || Math.abs(at - step.started) > stepSpan) {
    return undefined;
  }
  const { blockId, field, offset } = last;
  const text = last.text + op.text;
  return {
    op: { kind: 'insertText', blockId, field, offset, text },
    inverse: { kind: 'deleteText', blockId, field, from: offset, to: offset + text.length },
    started: step.started,
    at,
  };
}

export function record(history: History, op: Op, inverse: Op, at: number): History {
  const typed = history.sealed ? undefined : continued(history.done.at(-1), op, at);
  const done = typed
    ? [...history.done.slice(0, -1), typed]
    : [...history.done.slice(1 - maxSteps), { op, inverse, started: at, at }];
  return { done, undone: [], sealed: false };
}

export function undo(history: History): Travel | undefined {
  const step = history.done.at(-1);
  if (step === undefined) return undefined;
  return {
    history: { done: history.done.slice(0, -1), undone: [...history.undone, step], sealed: true },
    op: step.inverse,
    inverse: step.op,
  };
}

export function redo(history: History): Travel | undefined {
  const step = history.undone.at(-1);
  if (step === undefined) return undefined;
  return {
    history: { done: [...history.done, step], undone: history.undone.slice(0, -1), sealed: true },
    op: step.op,
    inverse: step.inverse,
  };
}
