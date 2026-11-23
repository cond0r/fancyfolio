'use client';

import { isLinkUrl } from '@fancyfolio/contracts';
import '@fancyfolio/editor/chrome.css';
import type { OnSave } from '@fancyfolio/editor/types';
import dynamic from 'next/dynamic';
import { useCallback, useRef } from 'react';
import { Callout } from '../../../components/blocks/callout';
import { Metric } from '../../../components/blocks/metric';

const Editor = dynamic(
  () =>
    Promise.all([import('@fancyfolio/editor/react'), import('./components')]).then(
      ([{ createReactEditor }, { components }]) =>
        createReactEditor({
          components,
          views: { callout: Callout, metric: Metric },
          insert: [
            { type: 'paragraph', props: {}, label: 'Text' },
            { type: 'heading', props: { level: 1 }, label: 'Heading 1' },
            { type: 'heading', props: { level: 2 }, label: 'Heading 2' },
            { type: 'heading', props: { level: 3 }, label: 'Heading 3' },
            {
              type: 'metric',
              props: {},
              label: 'Metric',
              iconPath: 'M3.5 12.5v-3M8 12.5v-9M12.5 12.5v-6',
            },
            {
              type: 'callout',
              props: { tone: 'info' },
              label: 'Callout',
              iconPath: 'M3.5 3.5h9v7h-5l-3 2.5v-2.5h-1zM8 6v1.5',
            },
          ],
        }),
    ),
  { ssr: false },
);

export function Playground({ body }: { readonly body: string }) {
  const commits = useRef<HTMLOutputElement>(null);
  const onRender = useCallback((id: string) => commits.current?.append(`${id} `), []);
  const saved = useRef<HTMLOutputElement>(null);
  const latest = useRef(1);
  const onSave = useCallback<OnSave>(async (markdown, version) => {
    if (version !== String(latest.current)) return { ok: false, reason: 'stale' };
    latest.current += 1;
    if (saved.current !== null) saved.current.textContent = markdown;
    return { ok: true, version: String(latest.current) };
  }, []);
  return (
    <>
      <div className="pl-16 md:pl-2 [&_h1]:mb-6 [&_h1]:text-4xl [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold [&_p]:mb-3 [&_pre]:mb-3 [&_pre]:font-mono [&_figure]:mt-3 [&_figure_p]:mt-3 [&_aside]:mt-0 [&_aside]:pt-4">
        <Editor
          markdown={body}
          version="1"
          onSave={onSave}
          onRender={onRender}
          safeHref={isLinkUrl}
        />
      </div>
      <output ref={commits} hidden data-testid="commits" />
      <output ref={saved} hidden data-testid="saved" />
    </>
  );
}
