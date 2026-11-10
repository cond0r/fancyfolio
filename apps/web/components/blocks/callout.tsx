import type { CalloutProps } from '@fancyfolio/contracts/blocks';
import type { ReactNode } from 'react';

const tones: { readonly [T in CalloutProps['tone']]: string } = {
  info: 'border-sky-400 bg-sky-50',
  warning: 'border-amber-400 bg-amber-50',
};

export function Callout({
  props,
  slots,
}: {
  readonly props: CalloutProps;
  readonly slots: { readonly body: ReactNode };
}) {
  return (
    <aside className={`my-6 rounded-lg border-l-4 px-4 py-1 ${tones[props.tone]}`}>
      {slots.body}
    </aside>
  );
}
