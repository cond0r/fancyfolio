import {
  type ErrorBody,
  errorBody,
  hostEnv,
  LIMITS,
  parseEnv,
  parseHost,
} from '@fancyfolio/contracts';
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { describeRoute, resolver, validator } from 'hono-openapi';
import * as v from 'valibot';

export type Env = { Variables: { requestId: string; tags: string[] | undefined } };

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

export const appHostOnly: MiddlewareHandler<Env> = async (c, next) => {
  const { ROOT_DOMAIN } = parseEnv(hostEnv, process.env);
  const host = parseHost(c.req.header('x-forwarded-host') ?? new URL(c.req.url).host);
  if (host?.hostname !== ROOT_DOMAIN && host?.hostname !== 'localhost') return notFound(c);
  await next();
};

export function notFound(c: Context<Env>) {
  return c.json({ error: 'Not found', requestId: c.get('requestId') } satisfies ErrorBody, 404);
}

export function refuse<E extends Env>(
  c: Context<E>,
  status: Refusal,
  message: string = statusText[status],
) {
  return c.json({ error: message, requestId: c.get('requestId') } satisfies ErrorBody, status);
}

export function errorCode(error: unknown): string | undefined {
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

export const onError: ErrorHandler<Env> = (error, c) =>
  error instanceof HTTPException && isRefusal(error.status)
    ? refuse(c, error.status)
    : internalError(error, c);

export function pathParams<Schema extends v.GenericSchema>(schema: Schema) {
  return validator('param', schema, (result, c: Context<Env>) => {
    if (!result.success) return notFound(c);
  });
}

export function requestHeaders<Schema extends v.GenericSchema>(schema: Schema) {
  return validator('header', schema, (result, c: Context<Env>) => {
    if (!result.success) return refuse(c, 400);
  });
}

export const limitBody = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (c) => refuse(c, 413) });
const jsonLimit = limitBody(LIMITS.jsonBodyBytes);

export function jsonBody<Schema extends v.GenericSchema>(schema: Schema) {
  const parsed = validator('json', schema, (result, c: Context<Env>) => {
    if (!result.success) return refuse(c, 400);
  });
  const readable: MiddlewareHandler<Env> = async (c, next) => {
    const tooLarge = await jsonLimit(c, async () => {});
    if (tooLarge) return tooLarge;
    const isJson = await c.req.json().then(
      () => true,
      () => false,
    );
    return isJson ? parsed(c, next) : refuse(c, 400);
  };
  return Object.assign(readable, parsed);
}

const statusText = {
  200: 'OK',
  201: 'Created',
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'Payload too large',
  429: 'Too many requests',
  500: 'Internal error',
  503: 'Service unavailable',
} as const;

type Status = keyof typeof statusText;
type Refusal = Exclude<Status, 200 | 201 | 500>;

function isRefusal(status: number): status is Refusal {
  return status in statusText && status >= 400 && status < 500;
}

function described(status: Status, schema: v.GenericSchema) {
  return [status, { description: statusText[status], schema }] as const;
}

export function responds(schema: v.GenericSchema, ...errors: Refusal[]) {
  return contract(200, schema, errors);
}

export function creates(schema: v.GenericSchema, ...errors: Refusal[]) {
  return contract(201, schema, errors);
}

function contract(success: 200 | 201, schema: v.GenericSchema, errors: Refusal[]) {
  const contracts = new Map<number, { description: string; schema: v.GenericSchema }>([
    described(success, schema),
    ...errors.map((status) => described(status, errorBody)),
    described(500, errorBody),
  ]);
  const check: MiddlewareHandler = async (c, next) => {
    await next();
    const contract = contracts.get(c.res.status);
    if (contract === undefined) throw new Error('Response status outside the route contract');
    v.parse(contract.schema, await c.res.clone().json());
  };
  const responses = Object.fromEntries(
    [...contracts].map(([status, contract]) => [
      status,
      {
        description: contract.description,
        content: { 'application/json': { schema: resolver(contract.schema) } },
      },
    ]),
  );
  return Object.assign(check, describeRoute({ responses }));
}
