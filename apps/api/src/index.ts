import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { openAPIRouteHandler } from 'hono-openapi';
import { auth } from './auth.ts';
import { ipGuard } from './middleware/ip-guard.ts';
import { health } from './routes/health.ts';
import { rooms } from './routes/rooms.ts';
import { sites } from './routes/sites.ts';
import { appHostOnly, type Env, encodedPath, notFound, onError, refused, shell } from './shell.ts';

const authRoutes = new Hono<Env>().use(
  bodyLimit({ maxSize: 8 * 1024, onError: (c) => refused(c, 413) }),
);
for (const { path } of Object.values(auth.api)) {
  if (path !== undefined && path !== auth.api.verifyPassword.path)
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
  .route('/v1/sites', sites)
  .route('/v1/rooms', rooms);

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
