import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Callout } from '../components/blocks/callout.tsx';

const quoted = '" onmouseover="alert(1)';

describe('the block views', () => {
  it.each([
    ['info', 'border-sky-400 bg-sky-50'],
    ['warning', 'border-amber-400 bg-amber-50'],
  ] as const)('render a %s callout around its slot', (tone, colours) => {
    const markup = renderToStaticMarkup(
      createElement(Callout, { props: { tone }, slots: { body: quoted } }),
    );
    expect(markup).toBe(
      `<aside class="my-6 rounded-lg border-l-4 px-4 py-1 ${colours}">&quot; onmouseover=&quot;alert(1)</aside>`,
    );
  });
});
