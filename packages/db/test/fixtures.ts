import { inject } from 'vitest';

export function requireWritable(): void {
  const refusal = inject('db').writeRefusal;
  if (refusal !== null) throw new Error(`Refused: ${refusal}`);
}
