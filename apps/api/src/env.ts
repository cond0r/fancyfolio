import * as v from 'valibot';

export const localEnv = v.object({
  PORT: v.pipe(
    v.optional(v.string(), '3001'),
    v.digits(),
    v.toNumber(),
    v.minValue(1),
    v.maxValue(65535),
  ),
});

export const databaseEnv = v.object({ DATABASE_URL: v.string() });
