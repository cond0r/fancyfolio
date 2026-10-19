import { Hono } from 'hono';
import { health } from './routes/health.ts';
import { type Env, encodedPath, notFound, onError, shell } from './shell.ts';

const app = new Hono<Env>({ getPath: encodedPath })
  .use(shell)
  .notFound(notFound)
  .onError(onError)
  .basePath('/api')
  .route('/health', health);

export default app;
