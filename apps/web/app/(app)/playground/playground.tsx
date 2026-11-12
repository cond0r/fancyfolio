'use client';

import type { OnSave } from '@fancyfolio/editor/types';
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
  const latest = useRef(1);
  const onSave = useCallback<OnSave>(async (_markdown, version) => {
    if (version !== String(latest.current)) return { ok: false, reason: 'stale' };
    latest.current += 1;
    return { ok: true, version: String(latest.current) };
  }, []);
  return (
    <>
      <div className="[&_[data-selected]]:bg-sky-100 [&_h1]:mb-6 [&_h1]:text-4xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold [&_p]:my-3 [&_pre]:my-3 [&_pre]:font-mono">
        <Editor markdown={body} version="1" onSave={onSave} onRender={onRender} />
      </div>
      <output ref={commits} hidden data-testid="commits" />
    </>
  );
}
