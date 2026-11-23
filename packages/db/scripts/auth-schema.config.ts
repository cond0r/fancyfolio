import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { authAdapterOptions, authSchemaOptions } from '../src/auth.ts';

export const auth = betterAuth({
  ...authSchemaOptions,
  database: drizzleAdapter({}, authAdapterOptions),
  plugins: [apiKey()],
});
