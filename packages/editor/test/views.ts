import type { Component, Views } from '../src/types.ts';

declare const metric: Component<'metric', { readonly tone: 'up' | 'down' }, 'value' | 'label'>;
type Host = readonly [typeof metric];

export const views: Views<Host> = {
  metric: ({ props, fields }) => [props.tone, fields.value, fields.label],
};

export const textOnly: Views<Host> = {
  // @ts-expect-error a field reaches a view as a ReactNode, never as a string
  metric: ({ fields }): string => fields.value,
};

// @ts-expect-error a host component without a view fails to compile
export const missing: Views<Host> = {};
