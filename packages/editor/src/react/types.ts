import type { ComponentType, ProfilerOnRenderCallback, ReactNode } from 'react';
import type { AnyComponent, Block, BlockOf, TypedBlock } from '../core/types.ts';

export type ViewProps<B extends TypedBlock<unknown, string>> = {
  readonly props: B['props'];
  readonly fields: { readonly [F in keyof B['fields']]: ReactNode };
};

export type Views<P extends readonly AnyComponent[]> = {
  readonly [B in BlockOf<P> as B['type']]: ComponentType<ViewProps<B>>;
};

export type AnyViews = { readonly [type: string]: ComponentType<ViewProps<Block>> };

export type ReactEditorOptions<P extends readonly AnyComponent[]> = {
  readonly components: P;
  readonly views: Views<P>;
};

export type EditorProps = {
  readonly markdown: string;
  readonly onRender?: ProfilerOnRenderCallback;
};
