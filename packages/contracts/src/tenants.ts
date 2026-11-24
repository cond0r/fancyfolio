import * as v from 'valibot';

export const tenantResponse = v.pipe(
  v.strictObject({ id: v.string(), subdomain: v.string() }),
  v.metadata({ ref: 'Tenant' }),
);

export type TenantResponse = v.InferOutput<typeof tenantResponse>;
