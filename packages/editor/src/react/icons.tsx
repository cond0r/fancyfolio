import type { Insertion } from './types.ts';

export const iconPaths = {
  plus: 'M8 3v10M3 8h10',
  cog: 'M6.6 3.3L6.8 1.6A6.5 6.5 0 0 1 9.2 1.6L9.4 3.3A4.9 4.9 0 0 1 10.3 3.7L11.6 2.6A6.5 6.5 0 0 1 13.4 4.4L12.3 5.7A4.9 4.9 0 0 1 12.7 6.6L14.4 6.8A6.5 6.5 0 0 1 14.4 9.2L12.7 9.4A4.9 4.9 0 0 1 12.3 10.3L13.4 11.6A6.5 6.5 0 0 1 11.6 13.4L10.3 12.3A4.9 4.9 0 0 1 9.4 12.7L9.2 14.4A6.5 6.5 0 0 1 6.8 14.4L6.6 12.7A4.9 4.9 0 0 1 5.7 12.3L4.4 13.4A6.5 6.5 0 0 1 2.6 11.6L3.7 10.3A4.9 4.9 0 0 1 3.3 9.4L1.6 9.2A6.5 6.5 0 0 1 1.6 6.8L3.3 6.6A4.9 4.9 0 0 1 3.7 5.7L2.6 4.4A6.5 6.5 0 0 1 4.4 2.6L5.7 3.7A4.9 4.9 0 0 1 6.6 3.3zM10 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0',
  duplicate: 'M5.5 5.5h7v7h-7zM10.5 3.5h-7v7',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  delete: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
  paragraph: 'M3 4h10M3 8h10M3 12h6',
  heading: 'M2.5 4v8M8 4v8M2.5 8H8',
  block: 'M3.5 3.5h9v9h-9z',
  bold: 'M4.5 3h4a2.5 2.5 0 0 1 0 5h-4zM4.5 8h5a2.5 2.5 0 0 1 0 5h-5z',
  italic: 'M7 3h5M4 13h5M10 3 6 13',
  strike:
    'M2.5 8h11M11 4.5C10.4 3.6 9.3 3 8 3 6.3 3 5 4 5 5.4M5 11.5c.6.9 1.7 1.5 3 1.5 1.7 0 3-1 3-2.5',
  highlight: 'M9.5 2.5l4 4-6 6h-4v-4zM7 5l4 4M2.5 14.5h11',
  code: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
  link: 'M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.75.75M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.75-.75',
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
