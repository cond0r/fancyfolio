import { serve } from '@hono/node-server';
import { localEnv, parseEnv } from './env.ts';
import app from './index.ts';

const { PORT } = parseEnv(localEnv, process.env);

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT }, (info) => {
  console.log(`API listening on http://127.0.0.1:${info.port}`);
});
