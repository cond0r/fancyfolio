import * as v from 'valibot';

export const errorBody = v.pipe(
  v.strictObject({ error: v.string(), requestId: v.string() }),
  v.metadata({ ref: 'ErrorBody' }),
);

export type ErrorBody = v.InferOutput<typeof errorBody>;
