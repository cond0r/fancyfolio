import { createTenantBody, tenantResponse } from '@fancyfolio/contracts';
import { profiles, tenants } from '@fancyfolio/db';
import { Hono } from 'hono';
import { auth, underAccountLimit } from '../auth.ts';
import { db } from '../db.ts';
import { requireSession, type SessionEnv } from '../middleware/session.ts';
import { creates, jsonBody, refuse } from '../shell.ts';

const conflicts = new Map([
  ['tenants_subdomain_unique', 'This subdomain is taken'],
  ['tenants_owner_id_unique', 'You already have a site'],
]);

function conflictOf(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause !== 'object' || cause === null) return undefined;
  if (!('code' in cause) || cause.code !== '23505' || !('constraint' in cause)) return undefined;
  return typeof cause.constraint === 'string' ? conflicts.get(cause.constraint) : undefined;
}

async function claimSite(userId: string, subdomain: string) {
  try {
    const tenant = await db.withTenant(
      { kind: 'user', userId, onboarding: true },
      async (tx, tenantId) => {
        if (tenantId === null) throw new Error('onboarding set no tenant id');
        await tx.insert(tenants).values({ id: tenantId, subdomain, ownerId: userId });
        await tx.insert(profiles).values({ tenantId });
        return { id: tenantId, subdomain };
      },
    );
    return { tenant };
  } catch (error) {
    const conflict = conflictOf(error);
    if (conflict === undefined) throw error;
    return { conflict };
  }
}

export const tenantsRoute = new Hono<SessionEnv>().post(
  '/',
  creates(tenantResponse, 400, 401, 409, 429),
  requireSession,
  jsonBody(createTenantBody),
  async (c) => {
    const userId = c.get('user').id;
    if (!(await underAccountLimit(await auth.$context, `${userId}|/v1/tenants`)))
      return refuse(c, 429);
    const claimed = await claimSite(userId, c.req.valid('json').subdomain);
    if ('conflict' in claimed) return refuse(c, 409, claimed.conflict);
    return c.json(claimed.tenant, 201);
  },
);
