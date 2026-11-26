export const colors = Object.freeze({
  red: 'ff-color-red',
  orange: 'ff-color-orange',
  green: 'ff-color-green',
  blue: 'ff-color-blue',
  purple: 'ff-color-purple',
});

export function isColor(value: unknown): value is keyof typeof colors {
  return typeof value === 'string' && Object.hasOwn(colors, value);
}
