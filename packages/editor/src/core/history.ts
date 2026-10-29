import type { History, Op, Step, Travel } from './types.ts';

export const emptyHistory: History = { done: [], undone: [], sealed: true };

const typingPause = 1000;
const stepSpan = 2000;
const maxSteps = 500;

function continued(step: Step | undefined, op: Op, at: number): Step | undefined {
  const last = step?.op;
  if (step === undefined || last?.type !== 'insertText' || op.type !== 'insertText') {
    return undefined;
  }
  if (last.id !== op.id || op.offset !== last.offset + last.text.length) return undefined;
  if (last.text.includes('\n')) return undefined;
  if (Math.abs(at - step.at) > typingPause || Math.abs(at - step.started) > stepSpan) {
    return undefined;
  }
  const text = last.text + op.text;
  return {
    op: { type: 'insertText', id: op.id, offset: last.offset, text },
    inverse: { type: 'deleteText', id: op.id, from: last.offset, to: last.offset + text.length },
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
