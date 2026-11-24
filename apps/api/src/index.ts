import { LIMITS } from '@fancyfolio/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { openAPIRouteHandler } from 'hono-openapi';
import { auth } from './auth.ts';
import { env } from './env.ts';
import { ipGuard } from './middleware/ip-guard.ts';
import { health } from './routes/health.ts';
import { me } from './routes/me.ts';
import { rooms } from './routes/rooms.ts';
import { sites } from './routes/sites.ts';
import { tenantsRoute } from './routes/tenants.ts';
import { appHostOnly, type Env, encodedPath, notFound, onError, refuse, shell } from './shell.ts';

const limitBody = (maxSize: number) => bodyLimit({ maxSize, onError: (c) => refuse(c, 413) });
const smallBody = limitBody(8 * 1024);
const seedEnvelope = JSON.stringify({ room: `playground:${crypto.randomUUID()}`, seed: {} });
// UTF-8 takes up to 3 bytes for each UTF-16 unit the seed limit counts
const seedBody = limitBody(3 * LIMITS.roomSeed + seedEnvelope.length);
const authRoutes = new Hono<Env>().use(smallBody);
for (const { path } of Object.values(auth.api)) {
  if (path !== undefined && !path.includes(':') && path !== auth.api.verifyPassword.path)
    authRoutes.all(path, ipGuard, (c) => auth.handler(c.req.raw));
}

const app = new Hono<Env>({ getPath: encodedPath })
  .use(shell)
  .use(appHostOnly)
  .notFound(notFound)
  .onError(onError)
  .basePath('/api')
  .route('/auth', authRoutes)
  .route('/health', health)
  .use('/v1/*', csrf({ origin: env.BETTER_AUTH_URL }))
  .use('/v1/tenants', smallBody)
  .use('/v1/rooms/auth', smallBody)
  .use('/v1/rooms/seed', seedBody)
  .route('/v1/sites', sites)
  .route('/v1/rooms', rooms)
  .route('/v1/me', me)
  .route('/v1/tenants', tenantsRoute);

app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: 'Fancyfolio API',
        version: '1',
        description: 'Generated from the contracts that validate every request and response.',
      },
    },
    defaultValidationErrorResponse: false,
  }),
);

export default app;
