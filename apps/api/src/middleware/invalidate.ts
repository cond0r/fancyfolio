import type { Context, MiddlewareHandler } from 'hono';
import { revalidate } from '../lib/revalidate.ts';
import type { Env } from '../shell.ts';

const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function invalidates<E extends Env>(c: Context<E>, ...tags: string[]) {
  c.set('tags', [...(c.get('tags') ?? []), ...tags]);
}

export const invalidate: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  const tags = c.get('tags') ?? [];
  if (!mutating.has(c.req.method) || c.res.status < 200 || c.res.status > 299) return;
  if (tags.length === 0) return;
  c.header('x-revalidated', String(await revalidate(tags, c.get('requestId'))));
};
