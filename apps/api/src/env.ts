import { parseDatabaseUrl, parseEnv } from '@fancyfolio/contracts';
import * as v from 'valibot';

export const localEnv = v.object({
  PORT: v.pipe(
    v.optional(v.string(), '3001'),
    v.digits(),
    v.toNumber(),
    v.minValue(1),
    v.maxValue(65535),
  ),
});

export const databaseEnv = v.object({ DATABASE_URL: v.string() });

export const liveblocksEnv = v.object({
  LIVEBLOCKS_SECRET_KEY: v.optional(v.pipe(v.string(), v.startsWith('sk_'))),
  LIVEBLOCKS_BASE_URL: v.optional(v.pipe(v.string(), v.url())),
  VERCEL_ENV: v.optional(v.picklist(['development', 'preview', 'production'])),
});

function isDatabaseUrl(url: string): boolean {
  try {
    parseDatabaseUrl(url);
    return true;
  } catch {
    return false;
  }
}

export const CLIENT_IP_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'x-vercel-forwarded-for',
] as const;

export const emailLength = 254;

const appOrigin = v.pipe(
  v.string(),
  v.regex(/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:[0-9]{1,5})?$/),
);
const secret = v.pipe(v.string(), v.regex(/^[\x21-\x7e]{32,}$/));

export const apiEnv = v.pipe(
  v.object({
    AUTH_DATABASE_URL: v.pipe(v.string(), v.check(isDatabaseUrl)),
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: appOrigin,
    CLIENT_IP_HEADER: v.picklist(CLIENT_IP_HEADERS),
    SIGNUP_ALLOWLIST: v.pipe(
      v.optional(v.string(), ''),
      v.transform((list) =>
        list
          .split(',')
          .map((email) => email.trim().toLowerCase())
          .filter((email) => email !== ''),
      ),
      v.array(v.pipe(v.string(), v.email(), v.maxLength(emailLength))),
    ),
    WEB_URL: appOrigin,
    REVALIDATE_SECRET: secret,
    VERCEL_ENV: liveblocksEnv.entries.VERCEL_ENV,
  }),
  v.forward(
    v.check(
      ({ BETTER_AUTH_URL, VERCEL_ENV }) =>
        VERCEL_ENV !== 'production' || BETTER_AUTH_URL.startsWith('https://'),
    ),
    ['BETTER_AUTH_URL'],
  ),
  v.forward(
    v.check(
      ({ WEB_URL, VERCEL_ENV }) => VERCEL_ENV !== 'production' || WEB_URL.startsWith('https://'),
    ),
    ['WEB_URL'],
  ),
  v.forward(
    v.check(
      ({ REVALIDATE_SECRET, BETTER_AUTH_SECRET }) => REVALIDATE_SECRET !== BETTER_AUTH_SECRET,
    ),
    ['REVALIDATE_SECRET'],
  ),
);

export const seedOwnerEnv = v.object({
  SEED_EMAIL: v.pipe(v.string(), v.email(), v.toLowerCase(), v.maxLength(emailLength)),
  SEED_NAME: v.string(),
  SEED_PASSWORD: v.string(),
});

export const env = parseEnv(apiEnv, process.env);
