import { parseEnv } from '@fancyfolio/contracts';
import { type TenantDatabase, tenantDatabase } from '@fancyfolio/db';
import { databaseEnv } from './env.ts';

let opened: TenantDatabase | undefined;

export const db: TenantDatabase = {
  withTenant: async (context, fn) => {
    opened ??= tenantDatabase(parseEnv(databaseEnv, process.env).DATABASE_URL);
    return opened.withTenant(context, fn);
  },
};
