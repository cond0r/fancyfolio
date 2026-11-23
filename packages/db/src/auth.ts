import type { BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { connect } from './client.ts';
import * as authSchema from './schema/auth.ts';
import { roleGuard, tenantLimits } from './with-tenant.ts';

export const authAdapterOptions = { provider: 'pg', usePlural: true } as const;

export const authSchemaOptions = {
  emailAndPassword: { enabled: true },
  rateLimit: { storage: 'database' },
  advanced: { database: { generateId: 'uuid', joins: true } },
} as const satisfies BetterAuthOptions;

function refusingBypass(pool: Pool): Pool {
  const checkRole = roleGuard({ pool }, 'authAdapter');
  return new Proxy(pool, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key, target);
      if ((key !== 'query' && key !== 'connect') || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await checkRole();
        return Reflect.apply(value, target, args);
      };
    },
  });
}

export function authAdapter(url: string) {
  return drizzleAdapter(
    drizzle({ client: refusingBypass(connect(url, tenantLimits)), schema: authSchema }),
    {
      ...authAdapterOptions,
      schema: authSchema,
      transaction: true,
    },
  );
}
