import * as v from 'valibot';

const label = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const hostHeader = /^([a-z0-9.-]+?)\.?(?::(\d{1,5}))?$/;

export const hostEnv = v.pipe(
  v.object({
    ROOT_DOMAIN: v.optional(v.string()),
    VERCEL_PROJECT_PRODUCTION_URL: v.optional(v.string()),
  }),
  v.transform((env) => ({ ROOT_DOMAIN: env.ROOT_DOMAIN ?? env.VERCEL_PROJECT_PRODUCTION_URL })),
  v.object({
    ROOT_DOMAIN: v.pipe(
      v.string(),
      v.maxLength(253),
      v.regex(new RegExp(`^${label}(\\.${label})*$`)),
    ),
  }),
);

export function parseHost(header: string): { hostname: string; port?: string } | undefined {
  const [, hostname, port] = hostHeader.exec(header.toLowerCase()) ?? [];
  if (hostname === undefined) return undefined;
  if (port !== undefined && !(Number(port) >= 1 && Number(port) <= 65535)) return undefined;
  return { hostname, port };
}
