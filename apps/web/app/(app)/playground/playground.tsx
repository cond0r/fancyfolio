'use client';

import dynamic from 'next/dynamic';
import { useCallback, useRef } from 'react';
import { Callout } from '../../../components/blocks/callout';
import { Metric } from '../../../components/blocks/metric';

const Editor = dynamic(
  () =>
    Promise.all([import('@fancyfolio/editor/react'), import('./components')]).then(
      ([{ createReactEditor }, { components }]) =>
        createReactEditor({ components, views: { callout: Callout, metric: Metric } }),
    ),
  { ssr: false },
);

export function Playground({ body }: { readonly body: string }) {
  const commits = useRef<HTMLOutputElement>(null);
  const onRender = useCallback((id: string) => commits.current?.append(`${id} `), []);
  return (
    <>
      <div className="[&_[data-selected]]:bg-sky-100 [&_h1]:mb-6 [&_h1]:text-4xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold [&_p]:my-3 [&_pre]:my-3 [&_pre]:font-mono">
        <Editor markdown={body} onRender={onRender} />
      </div>
      <output ref={commits} hidden data-testid="commits" />
    </>
  );
}
