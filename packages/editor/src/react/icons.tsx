import type { Insertion } from './types.ts';

export const iconPaths = {
  plus: 'M8 3v10M3 8h10',
  duplicate: 'M5.5 5.5h7v7h-7zM10.5 3.5h-7v7',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  delete: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
  paragraph: 'M3 4h10M3 8h10M3 12h6',
  heading: 'M2.5 4v8M8 4v8M2.5 8H8',
  block: 'M3.5 3.5h9v9h-9z',
};

const levels = [
  '',
  'M11 6l2-1.5V12',
  'M10.75 6a1.75 1.75 0 0 1 3.5 0c0 2-3.5 3-3.5 6h3.5',
  'M10.75 4.5h3.5l-2 2.5a2.25 2.25 0 1 1-1.5 4.25',
];

export function iconOf(kind: Insertion): string {
  if (kind.iconPath !== undefined) return kind.iconPath;
  if (kind.type === 'paragraph') return iconPaths.paragraph;
  if (kind.type !== 'heading') return iconPaths.block;
  const level =
    typeof kind.props === 'object' && kind.props !== null
      ? Reflect.get(kind.props, 'level')
      : undefined;
  return `${iconPaths.heading}${typeof level === 'number' ? (levels[level] ?? '') : ''}`;
}

export function Icon({ path }: { readonly path: string }) {
  return (
    <svg
      aria-hidden="true"
      data-ff-icon=""
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}
