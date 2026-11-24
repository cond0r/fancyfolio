import * as v from 'valibot';
import { tenantResponse } from './tenants.ts';

export const meResponse = v.pipe(
  v.strictObject({ email: v.string(), tenant: v.nullable(tenantResponse) }),
  v.metadata({ ref: 'Me' }),
);

export type MeResponse = v.InferOutput<typeof meResponse>;
