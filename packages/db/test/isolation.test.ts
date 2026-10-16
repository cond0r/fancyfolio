import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';
import { tenants } from '../src/schema/tenants.ts';
import { withTenant } from '../src/with-tenant.ts';
import { createTenant, createUser, deleteUsers, requireWritable } from './fixtures.ts';

const { appUrl, authUrl } = inject('db');
const app = connect(appUrl);
const auth = connect(authUrl);
const db = drizzle(app);
const denied = { cause: { code: '42501' } };
const a = { userId: '', tenantId: '' };
const b = { userId: '', tenantId: '' };

beforeAll(async () => {
  requireWritable();
  a.userId = await createUser(auth, 'Ines Okafor', 'ines@example.test');
  b.userId = await createUser(auth, 'Rafael Mendes', 'rafael@example.test');
  a.tenantId = await createTenant(db, a.userId, 'ines');
  b.tenantId = await createTenant(db, b.userId, 'rafael');
});

afterAll(async () => {
  await deleteUsers(auth, [a.userId, b.userId]);
  await Promise.all([app.end(), auth.end()]);
});

function rowsOf(userId: string) {
  return withTenant(db, { kind: 'user', userId }, (tx) =>
    tx
      .select({ id: tenants.id, subdomain: tenants.subdomain, ownerId: tenants.ownerId })
      .from(tenants),
  );
}

describe('tenants as ff_app without a context', () => {
  it('reads no row through raw SQL or the query builder', async () => {
    expect((await app`select id from tenants`).count).toBe(0);
    expect(await db.select().from(tenants)).toEqual([]);
  });

  it('cannot insert', async () => {
    await expect(
      db.insert(tenants).values({ id: randomUUID(), subdomain: 'nobody', ownerId: a.userId }),
    ).rejects.toMatchObject(denied);
  });

  it('reads no row and cannot insert in the job context', async () => {
    expect(await withTenant(db, { kind: 'job' }, (tx) => tx.select().from(tenants))).toEqual([]);
    await expect(
      withTenant(db, { kind: 'job' }, (tx) =>
        tx.insert(tenants).values({ id: randomUUID(), subdomain: 'nobody', ownerId: a.userId }),
      ),
    ).rejects.toMatchObject(denied);
  });
});

describe("tenants as ff_app in tenant A's context", () => {
  it("reads only A's row through the query builder and raw SQL", async () => {
    await withTenant(db, { kind: 'user', userId: a.userId }, async (tx) => {
      expect(await tx.select({ id: tenants.id }).from(tenants)).toEqual([{ id: a.tenantId }]);
      expect([...(await tx.execute(sql`select id from tenants`))]).toEqual([{ id: a.tenantId }]);
      expect(await tx.select().from(tenants).where(eq(tenants.id, b.tenantId))).toEqual([]);
      expect([...(await tx.execute(sql`select id from tenants where id = ${b.tenantId}`))]).toEqual(
        [],
      );
    });
  });

  it("cannot update or delete B's row, and B's row stays as it was", async () => {
    const attempts = [
      sql`update tenants set owner_id = ${a.userId} where id = ${b.tenantId}`,
      sql`delete from tenants where id = ${b.tenantId}`,
    ];
    for (const statement of attempts) {
      await expect(
        withTenant(db, { kind: 'user', userId: a.userId }, (tx) => tx.execute(statement)),
      ).rejects.toMatchObject(denied);
    }
    await expect(
      withTenant(db, { kind: 'user', userId: a.userId }, (tx) =>
        tx.update(tenants).set({ subdomain: 'taken' }).where(eq(tenants.id, b.tenantId)),
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      withTenant(db, { kind: 'user', userId: a.userId }, (tx) =>
        tx.delete(tenants).where(eq(tenants.id, b.tenantId)),
      ),
    ).rejects.toMatchObject(denied);
    expect(await rowsOf(b.userId)).toEqual([
      { id: b.tenantId, subdomain: 'rafael', ownerId: b.userId },
    ]);
  });

  it('cannot update or delete its own row: the subdomain is immutable', async () => {
    await expect(
      withTenant(db, { kind: 'user', userId: a.userId }, (tx) =>
        tx.update(tenants).set({ subdomain: 'renamed' }).where(eq(tenants.id, a.tenantId)),
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      withTenant(db, { kind: 'user', userId: a.userId }, (tx) =>
        tx.delete(tenants).where(eq(tenants.id, a.tenantId)),
      ),
    ).rejects.toMatchObject(denied);
    expect(await rowsOf(a.userId)).toEqual([
      { id: a.tenantId, subdomain: 'ines', ownerId: a.userId },
    ]);
  });

  it.each([
    ["B's tenant id", () => ({ id: b.tenantId, subdomain: 'forged', ownerId: a.userId })],
    ['another owner', () => ({ id: a.tenantId, subdomain: 'forged', ownerId: b.userId })],
    ['a new tenant id', () => ({ id: randomUUID(), subdomain: 'forged', ownerId: a.userId })],
  ])('cannot insert a row with %s', async (_case, row) => {
    await expect(
      withTenant(db, { kind: 'user', userId: a.userId }, (tx) => tx.insert(tenants).values(row())),
    ).rejects.toMatchObject(denied);
    expect(await rowsOf(b.userId)).toEqual([
      { id: b.tenantId, subdomain: 'rafael', ownerId: b.userId },
    ]);
  });
});
