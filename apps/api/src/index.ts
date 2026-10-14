import './env.ts';
import { Hono } from 'hono';
import { health } from './routes/health.ts';

const app = new Hono().basePath('/api').route('/health', health);

export default app;
