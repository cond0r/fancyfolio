import type { MiddlewareHandler } from 'hono';
import { auth } from '../auth.ts';
import { type Env, refuse } from '../shell.ts';

export type SessionEnv = {
  Variables: Env['Variables'] & { user: { id: string; email: string } };
};

export const requireSession: MiddlewareHandler<SessionEnv> = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session === null) return refuse(c, 401);
  c.set('user', { id: session.user.id, email: session.user.email });
  return next();
};
