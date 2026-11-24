import { meResponse } from '@fancyfolio/contracts';
import { tenants } from '@fancyfolio/db';
import { Hono } from 'hono';
import { db } from '../db.ts';
import { requireSession, type SessionEnv } from '../middleware/session.ts';
import { responds } from '../shell.ts';

export const me = new Hono<SessionEnv>().get(
  '/',
  responds(meResponse, 401),
  requireSession,
  async (c) => {
    const user = c.get('user');
    const tenant = await db.withTenant({ kind: 'user', userId: user.id }, async (tx, tenantId) => {
      if (tenantId === null) return null;
      const [row] = await tx.select({ id: tenants.id, subdomain: tenants.subdomain }).from(tenants);
      return row;
    });
    return c.json({ email: user.email, tenant });
  },
);
