import { serve } from '@hono/node-server';
import { env } from './env.ts';
import app from './index.ts';

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: env.PORT }, (info) => {
  console.log(`API listening on http://127.0.0.1:${info.port}`);
});
