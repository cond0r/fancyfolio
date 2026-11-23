import { authAdapter, authSchemaOptions } from '@fancyfolio/db';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import * as v from 'valibot';
import { env } from './env.ts';

const withoutToken = v.pipe(
  v.looseObject({ token: v.string() }),
  v.transform(({ token, ...rest }) => rest),
);
const tokenBodies = new Map<string, v.GenericSchema<unknown, object>>([
  ['/sign-in/email', withoutToken],
  ['/get-session', v.looseObject({ session: withoutToken })],
  ['/list-sessions', v.array(withoutToken)],
]);

export const auth = betterAuth({
  ...authSchemaOptions,
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.BETTER_AUTH_URL],
  database: authAdapter(env.AUTH_DATABASE_URL),
  rateLimit: {
    ...authSchemaOptions.rateLimit,
    enabled: true,
    customRules: {
      '/sign-up/email': { window: 3600, max: 5 },
      '/sign-in/email': { window: 60, max: 10 },
      '/change-password': { window: 10, max: 3 },
      '**': false,
    },
  },
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      const tokenBody = tokenBodies.get(ctx.path);
      const stripped = tokenBody && v.safeParse(tokenBody, ctx.context.returned);
      if (stripped?.success) return ctx.json(stripped.output);
    }),
  },
  advanced: {
    ...authSchemaOptions.advanced,
    ipAddress: { ipAddressHeaders: [env.CLIENT_IP_HEADER] },
    disableOriginCheck: false,
  },
});
