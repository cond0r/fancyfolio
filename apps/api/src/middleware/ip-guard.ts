import { getIPFromHeader } from '@better-auth/core/utils/ip';
import type { ErrorBody } from '@fancyfolio/contracts';
import type { MiddlewareHandler } from 'hono';
import { env } from '../env.ts';
import type { Env } from '../shell.ts';

export const ipGuard: MiddlewareHandler<Env> = async (c, next) => {
  const value = c.req.header(env.CLIENT_IP_HEADER);
  if (value !== undefined && getIPFromHeader(value) !== null) return next();
  const requestId = c.get('requestId');
  console.error(
    JSON.stringify({ requestId, error: 'ClientIpUnresolved', header: env.CLIENT_IP_HEADER }),
  );
  return c.json({ error: 'Service unavailable', requestId } satisfies ErrorBody, 503);
};
