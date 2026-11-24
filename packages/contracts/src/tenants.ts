import * as v from 'valibot';
import { isSubdomain } from './predicates.ts';

export const createTenantBody = v.pipe(
  v.strictObject({
    subdomain: v.pipe(
      v.string(),
      v.check(isSubdomain),
      v.description(
        '3 to 32 lower-case letters, digits and inner hyphens, no hyphens in positions 3 and 4, not reserved',
      ),
    ),
  }),
  v.metadata({ ref: 'CreateTenant' }),
);

export const tenantResponse = v.pipe(
  v.strictObject({ id: v.string(), subdomain: v.string() }),
  v.metadata({ ref: 'Tenant' }),
);

export type CreateTenant = v.InferOutput<typeof createTenantBody>;
export type TenantResponse = v.InferOutput<typeof tenantResponse>;
