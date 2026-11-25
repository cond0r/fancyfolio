import { profileResponse, updateProfileBody } from '@fancyfolio/contracts';
import { profiles } from '@fancyfolio/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { asOwner, updateVersioned } from '../lib/versioned-write.ts';
import { requireSession, type SessionEnv } from '../middleware/session.ts';
import { jsonBody, refuse, responds } from '../shell.ts';

const fields = {
  displayName: profiles.displayName,
  headline: profiles.headline,
  location: profiles.location,
  bioMd: profiles.bioMd,
  avatarUrl: profiles.avatarUrl,
  links: profiles.links,
  updatedAt: profiles.updatedAt,
};

export const profileRoute = new Hono<SessionEnv>()
  .get('/', responds(profileResponse, 401, 404), requireSession, async (c) => {
    const profile = await asOwner(c, async (tx, tenantId) => {
      const [row] = await tx.select(fields).from(profiles).where(eq(profiles.tenantId, tenantId));
      return row;
    });
    return profile == null ? refuse(c, 404) : c.json(profile);
  })
  .put(
    '/',
    responds(profileResponse, 400, 401, 404, 409, 413),
    requireSession,
    jsonBody(updateProfileBody),
    async (c) => {
      const { updatedAt, ...values } = c.req.valid('json');
      const saved = await asOwner(c, (tx, tenantId) =>
        updateVersioned(tx, profiles, eq(profiles.tenantId, tenantId), updatedAt, (where) =>
          tx.update(profiles).set(values).where(where).returning(fields),
        ),
      );
      if (saved === null || saved === 404) return refuse(c, 404);
      if (saved === 409) return refuse(c, 409, 'Changed elsewhere; reload and try again');
      return c.json(saved);
    },
  );
