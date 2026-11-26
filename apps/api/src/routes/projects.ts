import {
  createHeaders,
  createProjectBody,
  deleteBody,
  deletedResponse,
  itemParams,
  LIMITS,
  projectList,
  projectResponse,
  updateProjectBody,
} from '@fancyfolio/contracts';
import { projects } from '@fancyfolio/db';
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
  id: projects.id,
  name: projects.name,
  description: projects.description,
  url: projects.url,
  repoUrl: projects.repoUrl,
  tags: projects.tags,
  updatedAt: projects.updatedAt,
};
const stale = 'Changed elsewhere; reload and try again';

export const projectsRoute = new Hono<SessionEnv>()
  .get('/', responds(projectList, 401, 404), requireSession, async (c) => {
    const list = await asOwner(c, (tx, tenantId) =>
      tx
        .select(fields)
        .from(projects)
        .where(eq(projects.tenantId, tenantId))
        .orderBy(desc(projects.createdAt), asc(projects.id)),
    );
    return list === null ? refuse(c, 404) : c.json(list);
  })
  .post(
    '/',
    creates(projectResponse, 400, 401, 404, 409, 413, 503),
    requireSession,
    requestHeaders(createHeaders),
    jsonBody(createProjectBody),
    async (c) => {
      const id = c.req.valid('header')['idempotency-key'];
      const values = c.req.valid('json');
      const created = await asOwner(c, (tx, tenantId) =>
        insertCapped(
          tx,
          projects,
          LIMITS.projects,
          { id, tenantId },
          (where) => tx.select(fields).from(projects).where(where),
          () =>
            tx
              .insert(projects)
              .values({ ...values, id, tenantId })
              .onConflictDoNothing({ target: projects.id })
              .returning(fields),
        ),
      ).catch(busyOnLockTimeout);
      if (created === null) return refuse(c, 404);
      if (created === 'busy') return refuse(c, 503);
      if (created === 'full') {
        return refuse(c, 409, `You can keep at most ${LIMITS.projects} projects`);
      }
      if (created === 'taken') return refuse(c, 409);
      return c.json(created, 201);
    },
  )
  .get(
    '/:id',
    responds(projectResponse, 401, 404),
    requireSession,
    pathParams(itemParams),
    async (c) => {
      const row = await asOwner(c, async (tx, tenantId) => {
        const [found] = await tx
          .select(fields)
          .from(projects)
          .where(ownedItem(projects, tenantId, c.req.valid('param').id));
        return found;
      });
      return row == null ? refuse(c, 404) : c.json(row);
    },
  )
  .put(
    '/:id',
    responds(projectResponse, 400, 401, 404, 409, 413),
    requireSession,
    pathParams(itemParams),
    jsonBody(updateProjectBody),
    async (c) => {
      const { updatedAt, ...values } = c.req.valid('json');
      const saved = await asOwner(c, (tx, tenantId) =>
        updateVersioned(
          tx,
          projects,
          ownedItem(projects, tenantId, c.req.valid('param').id),
          updatedAt,
          (where) => tx.update(projects).set(values).where(where).returning(fields),
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
          projects,
          ownedItem(projects, tenantId, id),
          c.req.valid('json').updatedAt,
        ),
      );
      if (deleted === null || deleted === 404) return refuse(c, 404);
      if (deleted === 409) return refuse(c, 409, stale);
      return c.json({ id });
    },
  );
