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
