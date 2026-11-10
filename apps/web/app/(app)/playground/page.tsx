import type { Metadata } from 'next';
import { body } from './fixture';
import { Playground } from './playground';

export const metadata: Metadata = { title: 'Editor playground' };

export default function PlaygroundPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Playground body={body} />
    </main>
  );
}
