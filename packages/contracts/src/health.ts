import * as v from 'valibot';

const header = v.nullable(v.string());

export const healthResponse = v.pipe(
  v.strictObject({
    ok: v.literal(true),
    headers: v.strictObject({
      'x-forwarded-for': header,
      'x-real-ip': header,
      'x-vercel-forwarded-for': header,
    }),
    origin: header,
    cookieNames: v.array(v.string()),
  }),
  v.metadata({ ref: 'HealthResponse' }),
);

export type HealthResponse = v.InferOutput<typeof healthResponse>;
