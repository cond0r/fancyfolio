import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

export const auth = betterAuth({
  database: drizzleAdapter({}, { provider: 'pg', usePlural: true }),
  emailAndPassword: { enabled: true },
  rateLimit: { storage: 'database' },
  advanced: { database: { generateId: 'uuid' } },
  plugins: [apiKey()],
});
