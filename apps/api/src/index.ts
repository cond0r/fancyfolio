import { Hono } from 'hono';
import { openAPIRouteHandler } from 'hono-openapi';
import { health } from './routes/health.ts';
import { rooms } from './routes/rooms.ts';
import { sites } from './routes/sites.ts';
import { type Env, encodedPath, notFound, onError, shell } from './shell.ts';

const app = new Hono<Env>({ getPath: encodedPath })
  .use(shell)
  .notFound(notFound)
  .onError(onError)
  .basePath('/api')
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
