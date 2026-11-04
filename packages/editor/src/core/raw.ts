import { isRaw, noProps } from './model.ts';
import type { Fallback, Op } from './types.ts';

export const raw: Fallback = {
  name: 'raw',
  props: noProps,
  fields: ['text'],
  commands: {
    insertBreak({ doc, selection }) {
      if (selection.kind !== 'text') return undefined;
      const { blockId, field, from, to } = selection;
      const block = doc.blocks.get(blockId);
      if (block === undefined || !isRaw(block.type)) return undefined;
      const ops: Op[] = from < to ? [{ kind: 'deleteText', blockId, field, from, to }] : [];
      ops.push({ kind: 'insertText', blockId, field, offset: from, text: '\n' });
      return { ops, selection: { kind: 'text', blockId, field, from: from + 1, to: from + 1 } };
    },
  },
};
