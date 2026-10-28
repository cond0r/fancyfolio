import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';
import { domains, projects } from '../src/schema/content.ts';
import { type TenantPool, withTenant } from '../src/with-tenant.ts';
import { createTenant, createUser, deleteUsers, requireWritable, rows } from './fixtures.ts';

const { appUrl, authUrl } = inject('db');
const app = connect(appUrl);
const auth = connect(authUrl);
const db: TenantPool = { pool: app };
const owner = { userId: '', tenantId: '' };

beforeAll(async () => {
  requireWritable();
  owner.userId = await createUser(auth, 'Sofia Brandt', 'sofia.timestamps@example.test');
  owner.tenantId = await createTenant(db, owner.userId, 'sofia-timestamps');
});

afterAll(async () => {
  await deleteUsers(auth, [owner.userId]);
  await Promise.all([app.end(), auth.end()]);
});

it('reads created_at on projects and domains as the Postgres text, microseconds kept', async () => {
  const read = await withTenant(db, { kind: 'user', userId: owner.userId }, async (tx) => {
    await tx.insert(projects).values({ tenantId: owner.tenantId, name: 'Ledger' });
    await tx.insert(domains).values({
      tenantId: owner.tenantId,
      hostname: 'sofia.example.test',
      challengeToken: 'a'.repeat(43),
    });
    const [project] = await tx.select({ createdAt: projects.createdAt }).from(projects);
    const [domain] = await tx.select({ createdAt: domains.createdAt }).from(domains);
    const [text] = await rows<{ project: string; domain: string }>(tx)(
      sql`select (select created_at::text from projects) as project, (select created_at::text from domains) as domain`,
    );
    return { project: project.createdAt, domain: domain.createdAt, text };
  });
  expect(read.project).toBe(read.text.project);
  expect(read.domain).toBe(read.text.domain);
});
