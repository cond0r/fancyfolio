import {
  type CalloutProps,
  calloutProps,
  type MetricProps,
  metricProps,
} from '@fancyfolio/contracts/blocks';
import { containerDirective, leafDirective } from '@fancyfolio/editor';
import type { Block, BlockId, Component, DocView, Op } from '@fancyfolio/editor/types';

function emptyParagraph(id: BlockId): Block {
  return { id, type: 'paragraph', props: {}, fields: { text: '' } };
}

function holding(doc: DocView, blockId: BlockId) {
  for (const [index, id] of doc.ids.entries()) {
    const block = doc.blocks.get(id);
    const body = block?.type === 'callout' ? block.slots?.body : undefined;
    if (body?.includes(blockId)) return { index, body };
  }
  return undefined;
}

export const metric: Component<'metric', MetricProps, 'value' | 'label'> = {
  name: 'metric',
  props: metricProps,
  fields: ['value', 'label'],
  labels: { value: 'Metric value', label: 'Metric label' },
  markdown: leafDirective({
    name: 'metric',
    props: metricProps,
    keys: [],
    attributes: ['value', 'label'],
  }),
  commands: {
    insertBreak: ({ doc, selection }) =>
      selection.kind === 'text' && doc.blocks.get(selection.blockId)?.type === 'metric'
        ? { ops: [] }
        : undefined,
  },
};

const calloutCodec = containerDirective({
  name: 'callout',
  props: calloutProps,
  keys: ['tone'],
  attributes: [],
  slot: 'body',
});

export const callout: Component<'callout', CalloutProps, never, 'body'> = {
  name: 'callout',
  props: calloutProps,
  fields: [],
  labels: {},
  slots: ['body'],
  markdown: {
    ...calloutCodec,
    read(node) {
      const read = calloutCodec.read(node);
      if (read?.slots?.body.length !== 0) return read;
      return { ...read, slots: { body: [{ type: 'paragraph', children: [] }] } };
    },
  },
  commands: {
    insertBreak({ doc, selection, newId }) {
      if (selection.kind !== 'text' || selection.from !== selection.to) return undefined;
      const { blockId } = selection;
      const child = doc.blocks.get(blockId);
      const parent = holding(doc, blockId);
      if (child === undefined || parent?.body.at(-1) !== blockId) return undefined;
      if (Object.values(child.fields).some((text) => text !== '')) return undefined;
      const id = newId();
      return {
        ops: [
          { kind: 'removeBlock', blockId },
          { kind: 'insertBlock', block: emptyParagraph(id), parent: null, index: parent.index + 1 },
        ],
        selection: { kind: 'text', blockId: id, field: 'text', from: 0, to: 0 },
      };
    },
  },
  transform(op, after) {
    if (op.kind !== 'removeBlock') return [];
    return after.ids.flatMap((id): Op[] => {
      const block = after.blocks.get(id);
      if (block?.type !== 'callout' || block.slots?.body?.length !== 0) return [];
      const refill = emptyParagraph(crypto.randomUUID());
      return [
        { kind: 'insertBlock', block: refill, parent: { blockId: id, slot: 'body' }, index: 0 },
      ];
    });
  },
};

export const components = [metric, callout] as const;
