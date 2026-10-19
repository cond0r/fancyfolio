import { parseEnv } from '@fancyfolio/contracts';
import { tenantDatabase } from '@fancyfolio/db';
import { databaseEnv } from './env.ts';

export const db = tenantDatabase(parseEnv(databaseEnv, process.env).DATABASE_URL);
