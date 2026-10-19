import * as v from 'valibot';

export const errorBody = v.strictObject({ error: v.string(), requestId: v.string() });

export type ErrorBody = v.InferOutput<typeof errorBody>;
