import type { BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { connect } from './client.ts';
import * as authSchema from './schema/auth.ts';
import { tenantLimits } from './with-tenant.ts';

export const authAdapterOptions = { provider: 'pg', usePlural: true } as const;

export const authSchemaOptions = {
  emailAndPassword: { enabled: true },
  rateLimit: { storage: 'database' },
  advanced: { database: { generateId: 'uuid', joins: true } },
} as const satisfies BetterAuthOptions;

export function authAdapter(url: string) {
  return drizzleAdapter(drizzle({ client: connect(url, tenantLimits), schema: authSchema }), {
    ...authAdapterOptions,
    schema: authSchema,
    transaction: true,
  });
}
