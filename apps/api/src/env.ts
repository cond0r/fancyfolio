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

export const liveblocksEnv = v.object({
  LIVEBLOCKS_SECRET_KEY: v.optional(v.pipe(v.string(), v.startsWith('sk_'))),
  LIVEBLOCKS_BASE_URL: v.optional(v.pipe(v.string(), v.url())),
  VERCEL_ENV: v.optional(v.picklist(['development', 'preview', 'production'])),
});
