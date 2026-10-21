import type { ErrorBody } from '@fancyfolio/contracts';
import { sValidator } from '@hono/standard-validator';
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import * as v from 'valibot';

export type Env = { Variables: { requestId: string } };

// Hono routes on the decoded path, and its wildcard middleware never matches a decoded newline.
export function encodedPath(request: Request): string {
  return new URL(request.url).pathname;
}

export const shell: MiddlewareHandler<Env> = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  try {
    await next();
  } catch (thrown) {
    c.res = internalError(thrown, c);
  }
  c.header('X-Request-Id', requestId);
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', "default-src 'none'");
};

export function notFound(c: Context<Env>) {
  return c.json({ error: 'Not found', requestId: c.get('requestId') } satisfies ErrorBody, 404);
}

function errorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function environmentMessage(error: Error): string | undefined {
  const message: unknown = Object.getOwnPropertyDescriptor(error, 'message')?.value;
  return typeof message === 'string' && message.startsWith('Invalid environment: ')
    ? message
    : undefined;
}

function describeError(thrown: unknown) {
  if (!(thrown instanceof Error)) return { error: typeof thrown, code: errorCode(thrown) };
  const { stack } = thrown;
  return {
    error: thrown.name,
    code: errorCode(thrown),
    message: environmentMessage(thrown),
    paths:
      thrown instanceof v.ValiError ? thrown.issues.map((issue) => v.getDotPath(issue)) : undefined,
    stack:
      typeof stack === 'string'
        ? stack.split('\n').filter((line) => line.trimStart().startsWith('at '))
        : undefined,
  };
}

function internalError(thrown: unknown, c: Context<Env>) {
  const requestId = c.get('requestId');
  const request = { requestId, method: c.req.method, path: c.req.path };
  let line: string;
  try {
    line = JSON.stringify({ ...request, ...describeError(thrown) });
  } catch {
    line = JSON.stringify({ ...request, error: 'unreadable thrown value' });
  }
  console.error(line);
  return c.json({ error: 'Internal error', requestId } satisfies ErrorBody, 500);
}

export const onError: ErrorHandler<Env> = internalError;

export function pathParams<Schema extends v.GenericSchema>(schema: Schema) {
  return sValidator('param', schema, (result, c: Context<Env>) => {
    if (!result.success) return notFound(c);
  });
}
