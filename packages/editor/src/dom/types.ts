import type { BlockId, Commands } from '../core/types.ts';

export type Drop = Commands['moveBlockTo'];

export type Press = {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  readonly touch: boolean;
  readonly blockId: BlockId;
  started: boolean;
  block: HTMLElement | undefined;
  ghost: HTMLElement | undefined;
  aim: string | undefined;
  drop: Drop | undefined;
};

export type Targets = {
  readonly hovered?: BlockId | undefined;
  readonly selected?: BlockId | undefined;
  readonly pinned?: BlockId | undefined;
  readonly source?: BlockId | undefined;
  readonly aim?: { readonly blockId: BlockId; readonly side: 'before' | 'after' } | undefined;
};

export type Overlay = {
  readonly set: (patch: Targets) => void;
  readonly flush: () => void;
};

export type Box = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly handle: number;
  readonly column: number;
};
