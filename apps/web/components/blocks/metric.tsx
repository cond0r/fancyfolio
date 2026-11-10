import type { ReactNode } from 'react';

export function Metric({
  fields,
}: {
  readonly fields: { readonly value: ReactNode; readonly label: ReactNode };
}) {
  return (
    <figure className="my-6 rounded-lg border border-neutral-200 p-4">
      <p className="text-3xl font-semibold">{fields.value}</p>
      <figcaption className="text-sm text-neutral-600">{fields.label}</figcaption>
    </figure>
  );
}
