import type { AuthContext, BetterAuthOptions, GenericEndpointContext } from '@better-auth/core';
import { isHttpsUrl, LIMITS } from '@fancyfolio/contracts';
import { authAdapter, authSchemaOptions } from '@fancyfolio/db';
import { waitUntil } from '@vercel/functions';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import * as v from 'valibot';
import { emailLength, env } from './env.ts';
import { errorCode } from './shell.ts';

const signInRule = { window: 60, max: 10 };
const rateLimitRules = {
  '/sign-up/email': { window: 3600, max: 5 },
  '/sign-in/email': signInRule,
  '/change-password': { window: 10, max: 3 },
};
const longestWindow = Math.max(...Object.values(rateLimitRules).map(({ window }) => window));
const trustedDevice = 'trusted_device';
const trustedDeviceMaxAge = 30 * 24 * 60 * 60;
const displayName = v.pipe(v.string(), v.maxLength(LIMITS.displayName));
const image = v.nullish(v.pipe(v.string(), v.check(isHttpsUrl)));
const profileBodies = new Map<string, v.GenericSchema>([
  ['/sign-up/email', v.object({ name: displayName, image })],
  ['/update-user', v.object({ name: v.optional(displayName), image })],
]);
const signInBody = v.object({
  email: v.pipe(v.string(), v.email(), v.toLowerCase(), v.maxLength(emailLength)),
});
const withoutToken = v.pipe(
  v.looseObject({ token: v.string() }),
  v.transform(({ token, ...rest }) => rest),
);
const tokenBodies = new Map<string, v.GenericSchema<unknown, object>>([
  ['/sign-in/email', withoutToken],
  ['/get-session', v.looseObject({ session: withoutToken })],
  ['/list-sessions', v.array(withoutToken)],
  ['/change-password', withoutToken],
]);
const knownMessages = new Set([
  'User not found',
  'Password not found',
  'Invalid password',
  'Blocked cross-site navigation login attempt (CSRF protection)',
  '[better-auth] Warning: your BETTER_AUTH_SECRET appears low-entropy. Use a randomly generated secret for production.',
]);
let prunedAt = -Infinity;

export async function underAccountLimit<Options extends BetterAuthOptions>(
  { adapter, logger, runInBackground }: AuthContext<Options>,
  key: string,
): Promise<boolean> {
  const model = 'rateLimit';
  const byKey = [{ field: 'key', value: key }];
  const now = Date.now();
  const windowStart = now - signInRule.window * 1000;
  for (;;) {
    const counted = await adapter.incrementOne({
      model,
      where: [
        ...byKey,
        { field: 'lastRequest', operator: 'gt', value: windowStart },
        { field: 'count', operator: 'lt', value: signInRule.max },
      ],
      increment: { count: 1 },
      set: { lastRequest: now },
    });
    if (counted) return true;
    const restarted = await adapter.incrementOne({
      model,
      where: [...byKey, { field: 'lastRequest', operator: 'lte', value: windowStart }],
      increment: {},
      set: { count: 1, lastRequest: now },
    });
    if (restarted) return true;
    const row = await adapter.findOne<{ count: number; lastRequest: number }>({
      model,
      where: byKey,
    });
    if (row === null) {
      try {
        await adapter.create({ model, data: { key, count: 1, lastRequest: now } });
      } catch (error) {
        if ((await adapter.findOne({ model, where: byKey })) === null) throw error;
        continue;
      }
      if (now - prunedAt >= signInRule.window * 1000) {
        prunedAt = now;
        runInBackground(
          adapter
            .deleteMany({
              model,
              where: [{ field: 'lastRequest', operator: 'lt', value: now - longestWindow * 1000 }],
            })
            .catch((error: unknown) => logger.error('rate-limit prune failed', error)),
        );
      }
      return true;
    }
    if (row.count >= signInRule.max && row.lastRequest > windowStart) return false;
  }
}

async function accountKey(ctx: GenericEndpointContext): Promise<string | undefined> {
  if (ctx.path === '/change-password') {
    const session = await getSessionFromCtx(ctx, { disableRefresh: true });
    if (session === null)
      throw APIError.from('UNAUTHORIZED', { message: 'Unauthorized', code: 'UNAUTHORIZED' });
    return `${session.user.id}|${ctx.path}`;
  }
  if (ctx.path !== '/sign-in/email') return undefined;
  const body = v.safeParse(signInBody, ctx.body);
  if (!body.success) return undefined;
  const device = ctx.context.createAuthCookie(trustedDevice);
  const trusted = await ctx.getSignedCookie(device.name, ctx.context.secret);
  return trusted === body.output.email ? undefined : `${body.output.email}|${ctx.path}`;
}

export function createAuth(signupAllowlist: readonly string[]) {
  return betterAuth({
    ...authSchemaOptions,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    database: authAdapter(env.AUTH_DATABASE_URL),
    emailAndPassword: { ...authSchemaOptions.emailAndPassword, autoSignIn: false },
    rateLimit: {
      ...authSchemaOptions.rateLimit,
      enabled: true,
      customRules: { ...rateLimitRules, '**': false },
    },
    logger: {
      log(level, message, ...args: unknown[]) {
        const error = args.find((arg) => arg instanceof Error);
        console.error(
          JSON.stringify({
            auth: level,
            message: knownMessages.has(message) ? message : undefined,
            error: error?.name,
            code: errorCode(error),
          }),
        );
      },
    },
    onAPIError: { throw: true },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const profileBody = profileBodies.get(ctx.path);
        if (profileBody !== undefined && !v.is(profileBody, ctx.body)) {
          throw new APIError('BAD_REQUEST', { message: 'Bad request' });
        }
        const key = await accountKey(ctx);
        if (key !== undefined && !(await underAccountLimit(ctx.context, key))) {
          throw new APIError('TOO_MANY_REQUESTS', {
            message: 'Too many requests. Please try again later.',
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const signedIn = ctx.path === '/sign-in/email' && ctx.context.newSession?.user.email;
        if (signedIn) {
          const device = ctx.context.createAuthCookie(trustedDevice, {
            maxAge: trustedDeviceMaxAge,
          });
          await ctx.setSignedCookie(device.name, signedIn, ctx.context.secret, device.attributes);
        }
        const tokenBody = tokenBodies.get(ctx.path);
        const stripped = tokenBody && v.safeParse(tokenBody, ctx.context.returned);
        if (stripped?.success) return ctx.json(stripped.output);
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!signupAllowlist.includes(user.email)) {
              throw new APIError('FORBIDDEN', { message: 'Sign-up refused' });
            }
          },
        },
      },
    },
    advanced: {
      ...authSchemaOptions.advanced,
      ipAddress: { ipAddressHeaders: [env.CLIENT_IP_HEADER], ipv6Subnet: 48 },
      disableOriginCheck: false,
      backgroundTasks: { handler: waitUntil },
    },
  });
}

export const auth = createAuth(env.SIGNUP_ALLOWLIST);
