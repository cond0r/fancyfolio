import type { Metadata } from 'next';
import { Playground } from './playground';

export const metadata: Metadata = { title: 'Editor playground' };

const body = `# Field notes from Larkspur Outfitters

Larkspur Outfitters is an invented outdoor shop.

Its checkout took nine steps.

## Result

Three steps remained.
`;

export default function PlaygroundPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Playground body={body} />
    </main>
  );
}
