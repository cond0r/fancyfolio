import {
  createExperienceBody,
  createHeaders,
  deleteBody,
  deletedResponse,
  experienceList,
  experienceResponse,
  itemParams,
  LIMITS,
  updateExperienceBody,
} from '@fancyfolio/contracts';
import { experiences } from '@fancyfolio/db';
import { asc, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  asOwner,
  busyOnLockTimeout,
  deleteVersioned,
  insertCapped,
  ownedItem,
  updateVersioned,
} from '../lib/versioned-write.ts';
import { requireSession, type SessionEnv } from '../middleware/session.ts';
import { creates, jsonBody, pathParams, refuse, requestHeaders, responds } from '../shell.ts';

const fields = {
  id: experiences.id,
  company: experiences.company,
  role: experiences.role,
  location: experiences.location,
  startsOn: experiences.startsOn,
  endsOn: experiences.endsOn,
  summaryMd: experiences.summaryMd,
  updatedAt: experiences.updatedAt,
};
const stale = 'Changed elsewhere; reload and try again';

export const experiencesRoute = new Hono<SessionEnv>()
  .get('/', responds(experienceList, 401, 404), requireSession, async (c) => {
    const list = await asOwner(c, (tx, tenantId) =>
      tx
        .select(fields)
        .from(experiences)
        .where(eq(experiences.tenantId, tenantId))
        .orderBy(desc(experiences.startsOn), asc(experiences.id)),
    );
    return list === null ? refuse(c, 404) : c.json(list);
  })
  .post(
    '/',
    creates(experienceResponse, 400, 401, 404, 409, 413, 503),
    requireSession,
    requestHeaders(createHeaders),
    jsonBody(createExperienceBody),
    async (c) => {
      const id = c.req.valid('header')['idempotency-key'];
      const values = c.req.valid('json');
      const created = await asOwner(c, (tx, tenantId) =>
        insertCapped(
          tx,
          experiences,
          LIMITS.experiences,
          { id, tenantId },
          (where) => tx.select(fields).from(experiences).where(where),
          () =>
            tx
              .insert(experiences)
              .values({ ...values, id, tenantId })
              .onConflictDoNothing({ target: experiences.id })
              .returning(fields),
        ),
      ).catch(busyOnLockTimeout);
      if (created === null) return refuse(c, 404);
      if (created === 'busy') return refuse(c, 503);
      if (created === 'full') {
        return refuse(c, 409, `You can keep at most ${LIMITS.experiences} experiences`);
      }
      if (created === 'taken') return refuse(c, 409);
      return c.json(created, 201);
    },
  )
  .get(
    '/:id',
    responds(experienceResponse, 401, 404),
    requireSession,
    pathParams(itemParams),
    async (c) => {
      const row = await asOwner(c, async (tx, tenantId) => {
        const [found] = await tx
          .select(fields)
          .from(experiences)
          .where(ownedItem(experiences, tenantId, c.req.valid('param').id));
        return found;
      });
      return row == null ? refuse(c, 404) : c.json(row);
    },
  )
  .put(
    '/:id',
    responds(experienceResponse, 400, 401, 404, 409, 413),
    requireSession,
    pathParams(itemParams),
    jsonBody(updateExperienceBody),
    async (c) => {
      const { updatedAt, ...values } = c.req.valid('json');
      const saved = await asOwner(c, (tx, tenantId) =>
        updateVersioned(
          tx,
          experiences,
          ownedItem(experiences, tenantId, c.req.valid('param').id),
          updatedAt,
          (where) => tx.update(experiences).set(values).where(where).returning(fields),
        ),
      );
      if (saved === null || saved === 404) return refuse(c, 404);
      if (saved === 409) return refuse(c, 409, stale);
      return c.json(saved);
    },
  )
  .delete(
    '/:id',
    responds(deletedResponse, 400, 401, 404, 409, 413),
    requireSession,
    pathParams(itemParams),
    jsonBody(deleteBody),
    async (c) => {
      const { id } = c.req.valid('param');
      const deleted = await asOwner(c, (tx, tenantId) =>
        deleteVersioned(
          tx,
          experiences,
          ownedItem(experiences, tenantId, id),
          c.req.valid('json').updatedAt,
        ),
      );
      if (deleted === null || deleted === 404) return refuse(c, 404);
      if (deleted === 409) return refuse(c, 409, stale);
      return c.json({ id });
    },
  );
