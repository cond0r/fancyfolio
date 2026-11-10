import type { Component, Views } from '../src/types.ts';

declare const metric: Component<'metric', { readonly tone: 'up' | 'down' }, 'value' | 'label'>;
declare const callout: Component<'callout', { readonly tone: 'info' }, never, 'body'>;
type Host = readonly [typeof metric, typeof callout];

export const views: Views<Host> = {
  metric: ({ props, fields }) => [props.tone, fields.value, fields.label],
  callout: ({ props, slots }) => [props.tone, slots.body],
};

export const textOnly: Views<Host> = {
  // @ts-expect-error a field reaches a view as a ReactNode, never as a string
  metric: ({ fields }): string => fields.value,
  // @ts-expect-error a slot reaches a view as a ReactNode, never as its block ids
  callout: ({ slots }): readonly string[] => slots.body,
};

// @ts-expect-error a host component without a view fails to compile
export const missing: Views<Host> = {};
