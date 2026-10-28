import { randomUUID } from 'node:crypto';
import { LIMITS } from '@fancyfolio/contracts';
import { eq, type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';
import { caseStudies, experiences, profiles, projects } from '../src/schema/content.ts';
import { tenants } from '../src/schema/tenants.ts';
import { type TenantPool, type TenantTransaction, withTenant } from '../src/with-tenant.ts';
import { createTenant, createUser, deleteUsers, requireWritable, rows } from './fixtures.ts';

const { appUrl, authUrl } = inject('db');
const app = connect(appUrl);
const auth = connect(authUrl);
const db: TenantPool = { pool: app };
const noContext = drizzle(app);
const denied = { cause: { code: '42501' } };
const refusedBy = (constraint: string) => ({
  cause: { code: '23514', constraint },
});
const store = 'k3x9q2m7.public.blob.vercel-storage.com';
const missingKey = { cause: { code: '23503', constraint: 'case_studies_experience_fk' } };

type Seeded = {
  userId: string;
  tenantId: string;
  experienceId: string;
  publishedId: string;
  draftId: string;
  probeId: string;
};

const blank = (): Seeded => ({
  userId: '',
  tenantId: '',
  experienceId: '',
  publishedId: '',
  draftId: '',
  probeId: '',
});
const a = blank();
const b = blank();

const tables = { profiles, experiences, case_studies: caseStudies, projects };
type TableName = keyof typeof tables;
const tableNames = ['profiles', 'experiences', 'case_studies', 'projects'] as const;

const forgedRow: Record<TableName, (tenantId: string, updatedAt?: SQL) => SQL> = {
  profiles: (tenantId, updatedAt = sql`default`) =>
    sql`insert into profiles (tenant_id, updated_at) values (${tenantId}, ${updatedAt})`,
  experiences: (tenantId, updatedAt = sql`default`) =>
    sql`insert into experiences (tenant_id, company, role, starts_on, updated_at) values (${tenantId}, 'Forged', 'Forged', '2020-01-01', ${updatedAt})`,
  case_studies: (tenantId, updatedAt = sql`default`) =>
    sql`insert into case_studies (tenant_id, slug, title, updated_at) values (${tenantId}, 'forged', 'Forged', ${updatedAt})`,
  projects: (tenantId, updatedAt = sql`default`) =>
    sql`insert into projects (tenant_id, name, updated_at) values (${tenantId}, 'Forged', ${updatedAt})`,
};

async function seed(target: Seeded, name: string, email: string, subdomain: string) {
  target.userId = await createUser(auth, name, email);
  target.tenantId = await createTenant(db, target.userId, subdomain);
  await withTenant(db, { kind: 'user', userId: target.userId }, async (tx) => {
    const tenantId = target.tenantId;
    await tx.insert(profiles).values({ tenantId, displayName: name });
    const [experience] = await tx
      .insert(experiences)
      .values({
        tenantId,
        company: 'Northwind Labs',
        role: 'Staff engineer',
        startsOn: '2022-03-01',
      })
      .returning({ id: experiences.id });
    target.experienceId = experience.id;
    const studies = await tx
      .insert(caseStudies)
      .values([
        { tenantId, slug: 'billing-rewrite', title: 'Billing rewrite', publishedAt: sql`now()` },
        { tenantId, slug: 'search-draft', title: 'Search draft' },
        { tenantId, slug: 'hash-probe', title: 'Probe' },
      ])
      .returning({ id: caseStudies.id });
    [target.publishedId, target.draftId, target.probeId] = studies.map((study) => study.id);
    await tx.insert(projects).values({ tenantId, name: 'Ledger', tags: ['postgres'] });
  });
}

beforeAll(async () => {
  requireWritable();
  await seed(a, 'Ines Okafor', 'ines.content@example.test', 'ines-content');
  await seed(b, 'Rafael Mendes', 'rafael.content@example.test', 'rafael-content');
});

afterAll(async () => {
  await deleteUsers(auth, [a.userId, b.userId]);
  await Promise.all([app.end(), auth.end()]);
});

function asOwner<T>(owner: Seeded, fn: (tx: TenantTransaction) => Promise<T>) {
  return withTenant(db, { kind: 'user', userId: owner.userId }, fn);
}

async function tenantsOf(tx: TenantTransaction, name: TableName) {
  const found = await rows<{ tenant: string }>(tx)(
    sql`select tenant_id::text as tenant from ${tables[name]}`,
  );
  return [...new Set(found.map((row) => row.tenant))];
}

describe.each(tableNames)('%s', (name) => {
  const table = tables[name];

  it('shows no row and refuses an insert without a context and in the job context', async () => {
    expect(await rows(noContext)(sql`select tenant_id from ${table}`)).toEqual([]);
    await expect(noContext.execute(forgedRow[name](a.tenantId))).rejects.toMatchObject(denied);
    await withTenant(db, { kind: 'job' }, async (tx) => {
      expect(await tenantsOf(tx, name)).toEqual([]);
    });
    await expect(
      withTenant(db, { kind: 'job' }, (tx) => tx.execute(forgedRow[name](a.tenantId))),
    ).rejects.toMatchObject(denied);
  });

  it("shows A only A's rows", async () => {
    await asOwner(a, async (tx) => {
      expect(await tenantsOf(tx, name)).toEqual([a.tenantId]);
      expect(await rows(tx)(sql`select 1 from ${table} where tenant_id = ${b.tenantId}`)).toEqual(
        [],
      );
    });
  });

  it("lets A update and delete none of B's rows, which stay as they were", async () => {
    const before = await asOwner(b, (tx) =>
      rows(tx)(sql`select * from ${table} order by updated_at`),
    );
    await asOwner(a, async (tx) => {
      const updated = await tx.execute(
        sql`update ${table} set tenant_id = ${a.tenantId} where tenant_id = ${b.tenantId}`,
      );
      expect(updated.rowCount).toBe(0);
      if (name !== 'profiles') {
        const deleted = await tx.execute(sql`delete from ${table} where tenant_id = ${b.tenantId}`);
        expect(deleted.rowCount).toBe(0);
      }
    });
    const after = await asOwner(b, (tx) =>
      rows(tx)(sql`select * from ${table} order by updated_at`),
    );
    expect(after).toEqual(before);
  });

  it("refuses A an insert for B's tenant", async () => {
    await expect(asOwner(a, (tx) => tx.execute(forgedRow[name](b.tenantId)))).rejects.toMatchObject(
      denied,
    );
  });

  it('refuses a write to onboarding until its tenant row exists, then allows it', async () => {
    const userId = await createUser(auth, 'Lena Fischer', `lena.${name}@example.test`);
    const rollback = new Error('rollback');
    try {
      await expect(
        withTenant(db, { kind: 'user', userId, onboarding: true }, (tx, tenantId) =>
          tx.execute(forgedRow[name](tenantId ?? '')),
        ),
      ).rejects.toMatchObject(denied);
      await expect(
        withTenant(db, { kind: 'user', userId, onboarding: true }, async (tx, tenantId) => {
          const id = tenantId ?? '';
          await tx
            .insert(tenants)
            .values({ id, subdomain: `lena-${name.replace('_', '-')}`, ownerId: userId });
          await tx.execute(forgedRow[name](id));
          expect(await tenantsOf(tx, name)).toEqual([id]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await deleteUsers(auth, [userId]);
    }
  });

  it.each(['infinity', '9999-01-01', '294276-12-31 23:59:59 UTC'])(
    'stamps updated_at on insert when the statement sets %s',
    async (stamp) => {
      const userId = await createUser(auth, 'Noor Haddad', `noor.${name}@example.test`);
      const rollback = new Error('rollback');
      let outcome: unknown;
      try {
        await expect(
          withTenant(db, { kind: 'user', userId, onboarding: true }, async (tx, tenantId) => {
            const id = tenantId ?? '';
            await tx
              .insert(tenants)
              .values({ id, subdomain: `noor-${name.replace('_', '-')}`, ownerId: userId });
            await tx.execute(forgedRow[name](id, sql`${stamp}::timestamptz`));
            const [row] = await rows<{ stamped: boolean }>(tx)(
              sql`select bool_and(updated_at between now() and clock_timestamp()) as stamped from ${table}`,
            );
            const stale = await tx.execute(
              sql`update ${table} set tenant_id = tenant_id where updated_at = ${stamp}::timestamptz`,
            );
            const fresh = await tx.execute(sql`update ${table} set tenant_id = tenant_id`);
            outcome = { stamped: row.stamped, stale: stale.rowCount, fresh: fresh.rowCount };
            throw rollback;
          }),
        ).rejects.toBe(rollback);
        expect(outcome).toEqual({ stamped: true, stale: 0, fresh: 1 });
      } finally {
        await deleteUsers(auth, [userId]);
      }
    },
  );

  it('moves updated_at on every update, whatever value the statement sets', async () => {
    const latest = async (tx: TenantTransaction) => {
      const [row] = await rows<{ stamp: string }>(tx)(
        sql`select max(updated_at)::text as stamp from ${table}`,
      );
      return row;
    };
    const moved = async (tx: TenantTransaction, since: string) => {
      const [row] = await rows<{ moved: boolean }>(tx)(
        sql`select bool_and(updated_at > ${since}::timestamptz) as moved from ${table}`,
      );
      return row.moved;
    };
    const before = await asOwner(a, latest);
    await asOwner(a, (tx) =>
      tx.execute(
        sql`update ${table} set updated_at = '2000-01-01' where tenant_id = ${a.tenantId}`,
      ),
    );
    const outcome = await asOwner(a, async (tx) => {
      const first = await moved(tx, before.stamp);
      const after = await latest(tx);
      await tx.execute(
        sql`update ${table} set tenant_id = tenant_id where tenant_id = ${a.tenantId}`,
      );
      const second = await moved(tx, after.stamp);
      const again = await latest(tx);
      await tx.execute(
        sql`update ${table} set tenant_id = tenant_id where tenant_id = ${a.tenantId}`,
      );
      return [first, second, await moved(tx, again.stamp)];
    });
    expect(outcome).toEqual([true, true, true]);
  });
});

describe('the public site context', () => {
  it('reads the profile, experiences, projects and only the published case study', async () => {
    const seen = await withTenant(
      db,
      { kind: 'site', site: 'ines-content' },
      async (tx, tenantId) => ({
        tenantId,
        profiles: await tenantsOf(tx, 'profiles'),
        experiences: await tenantsOf(tx, 'experiences'),
        projects: await tenantsOf(tx, 'projects'),
        caseStudies: await tx.select({ id: caseStudies.id }).from(caseStudies),
      }),
    );
    expect(seen).toEqual({
      tenantId: a.tenantId,
      profiles: [a.tenantId],
      experiences: [a.tenantId],
      projects: [a.tenantId],
      caseStudies: [{ id: a.publishedId }],
    });
  });

  it.each(tableNames)(
    "cannot insert, update or delete %s rows, even its own tenant's",
    async (name) => {
      const readOnly = { cause: { code: '25006' } };
      for (const statement of [
        forgedRow[name](a.tenantId),
        sql`update ${tables[name]} set tenant_id = tenant_id where tenant_id = ${a.tenantId}`,
        sql`delete from ${tables[name]} where tenant_id = ${a.tenantId}`,
      ]) {
        await expect(
          withTenant(db, { kind: 'site', site: 'ines-content' }, (tx) => tx.execute(statement)),
        ).rejects.toMatchObject(readOnly);
      }
    },
  );
});

describe('profiles', () => {
  it('cannot be deleted: a profile lives as long as its tenant', async () => {
    await expect(
      asOwner(a, (tx) => tx.delete(profiles).where(eq(profiles.tenantId, a.tenantId))),
    ).rejects.toMatchObject(denied);
  });
});

describe('the experience link', () => {
  it("refuses another tenant's experience on insert and on update", async () => {
    await expect(
      asOwner(a, (tx) =>
        tx.insert(caseStudies).values({
          tenantId: a.tenantId,
          slug: 'borrowed',
          title: 'Borrowed',
          experienceId: b.experienceId,
        }),
      ),
    ).rejects.toMatchObject(missingKey);
    await expect(
      asOwner(a, (tx) =>
        tx
          .update(caseStudies)
          .set({ experienceId: b.experienceId })
          .where(eq(caseStudies.id, a.draftId)),
      ),
    ).rejects.toMatchObject(missingKey);
  });

  it('loses only the link when the experience is deleted, and keeps its tenant', async () => {
    const outcome = await asOwner(a, async (tx) => {
      const [gone] = await tx
        .insert(experiences)
        .values({
          tenantId: a.tenantId,
          company: 'Fabrikam',
          role: 'Engineer',
          startsOn: '2019-01-01',
        })
        .returning({ id: experiences.id });
      await tx
        .update(caseStudies)
        .set({ experienceId: gone.id })
        .where(eq(caseStudies.id, a.draftId));
      await tx.delete(experiences).where(eq(experiences.id, gone.id));
      return tx
        .select({ tenantId: caseStudies.tenantId, experienceId: caseStudies.experienceId })
        .from(caseStudies)
        .where(eq(caseStudies.id, a.draftId));
    });
    expect(outcome).toEqual([{ tenantId: a.tenantId, experienceId: null }]);
  });
});

describe('the source hash', () => {
  const stored = 'a'.repeat(64);
  const pushed = 'b'.repeat(64);

  function hashAfter(change: SQL, published = false) {
    return asOwner(a, async (tx) => {
      const id = a.probeId;
      await tx.execute(
        sql`update case_studies set source_hash = null, slug = 'hash-probe', title = 'Probe', summary = '', body_md = 'body', cover_url = null, experience_id = null, published_at = ${published ? sql`now() - interval '1 day'` : null} where id = ${id}`,
      );
      await tx.execute(sql`update case_studies set source_hash = ${stored} where id = ${id}`);
      await tx.execute(sql`update case_studies set ${change} where id = ${id}`);
      const [row] = await rows<{ hash: string | null }>(tx)(
        sql`select source_hash as hash from case_studies where id = ${id}`,
      );
      return row.hash;
    });
  }

  it.each([
    ['the slug', sql`slug = 'hash-probe-renamed'`],
    ['the title', sql`title = 'Edited'`],
    ['the summary', sql`summary = 'Edited'`],
    ['the body', sql`body_md = 'edited'`],
    ['the body that repeats the stored hash', sql`body_md = 'edited', source_hash = ${stored}`],
    ['publication', sql`published_at = now()`],
  ])('clears the hash on a change to %s without a new hash', async (_change, change) => {
    expect(await hashAfter(change)).toBeNull();
  });

  it('clears the hash when a published row is unpublished', async () => {
    expect(await hashAfter(sql`published_at = null`, true)).toBeNull();
  });

  it.each([
    [
      'a new hash set together with the body',
      () => sql`body_md = 'edited', source_hash = ${pushed}`,
      pushed,
    ],
    [
      'a new hash set together with the slug and publication',
      () => sql`slug = 'hash-probe-pushed', published_at = now(), source_hash = ${pushed}`,
      pushed,
    ],
    ['nothing but updated_at changing', () => sql`updated_at = now()`, stored],
    ['an experience link change', () => sql`experience_id = ${a.experienceId}`, stored],
  ])('keeps the hash for %s', async (_change, change, expected) => {
    expect(await hashAfter(change())).toBe(expected);
  });

  it('keeps the hash for a cover change', async () => {
    const cover = `https://${store}/tenants/${a.tenantId}/cover-${randomUUID()}.webp`;
    expect(await hashAfter(sql`cover_url = ${cover}`)).toBe(stored);
  });

  it('keeps the hash when the publication time of a published row changes', async () => {
    expect(await hashAfter(sql`published_at = published_at - interval '1 hour'`, true)).toBe(
      stored,
    );
  });

  it('refuses a source hash that is not 64 lower-case hex digits', async () => {
    for (const hash of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\n`, 'g'.repeat(64)]) {
      await expect(hashAfter(sql`source_hash = ${hash}`), hash).rejects.toMatchObject(
        refusedBy('case_studies_source_hash_check'),
      );
    }
  });
});

describe('blob URLs', () => {
  const url = (tenant: string, path = `avatar-${randomUUID()}.webp`) =>
    `https://${store}/tenants/${tenant}/${path}`;

  const hostile = () => [
    ["another tenant's prefix", url(b.tenantId)],
    ['http', url(a.tenantId).replace('https:', 'http:')],
    ['a parent segment', url(a.tenantId, `../${b.tenantId}/x.webp`)],
    ['an encoded parent segment', url(a.tenantId, '%2e%2e/x.webp')],
    ['a nested path', url(a.tenantId, 'nested/x.webp')],
    ['a query string', url(a.tenantId, 'x.webp?y=1')],
    ['a fragment', url(a.tenantId, 'x.webp#y')],
    ['credentials', url(a.tenantId).replace('https://', 'https://user@')],
    ['a port', url(a.tenantId).replace(store, `${store}:8443`)],
    ['another host', url(a.tenantId).replace(store, 'store.example')],
    ['a link-local address', url(a.tenantId).replace(store, '169.254.169.254')],
    ['localhost', url(a.tenantId).replace(store, 'localhost')],
    ['the store suffix as a label', url(a.tenantId).replace(store, `${store}.evil.example`)],
    ['the bare store suffix', url(a.tenantId).replace(store, 'public.blob.vercel-storage.com')],
    ['a nested store label', url(a.tenantId).replace(store, `x.${store}`)],
    ['an HTML file', url(a.tenantId, 'avatar.html')],
    ['an SVG file', url(a.tenantId, 'avatar.svg')],
    ['an upper-case extension', url(a.tenantId, 'avatar.WEBP')],
    ['no extension', url(a.tenantId, 'avatar')],
    ['an upper-case tenant id', url(a.tenantId.toUpperCase())],
    ['no file', url(a.tenantId, '')],
    ['a javascript URL', `javascript:alert(1)//tenants/${a.tenantId}/x.webp`],
    ['a trailing newline', `${url(a.tenantId)}\n`],
  ];

  it.each(['png', 'jpg', 'jpeg', 'webp'])(
    "accepts a .%s avatar and cover under the row's own tenant prefix",
    async (extension) => {
      await asOwner(a, async (tx) => {
        await tx.update(profiles).set({ avatarUrl: url(a.tenantId, `avatar-a1.${extension}`) });
        await tx
          .update(caseStudies)
          .set({ coverUrl: url(a.tenantId, `cover-${randomUUID()}.${extension}`) })
          .where(eq(caseStudies.id, a.draftId));
      });
    },
  );

  it('refuses every avatar_url outside the tenant prefix', async () => {
    for (const [what, value] of hostile()) {
      await expect(
        asOwner(a, (tx) => tx.update(profiles).set({ avatarUrl: value })),
        what,
      ).rejects.toMatchObject(refusedBy('profiles_avatar_url_check'));
    }
  });

  it('refuses every cover_url outside the tenant prefix', async () => {
    for (const [what, value] of hostile()) {
      await expect(
        asOwner(a, (tx) =>
          tx.update(caseStudies).set({ coverUrl: value }).where(eq(caseStudies.id, a.draftId)),
        ),
        what,
      ).rejects.toMatchObject(refusedBy('case_studies_cover_url_check'));
    }
  });
});

describe('field bounds', () => {
  const fences = (count: number) => ':::note\n'.repeat(count);
  const rowOf: Record<TableName, () => SQL> = {
    profiles: () => sql`tenant_id = ${a.tenantId}`,
    experiences: () => sql`id = ${a.experienceId}`,
    case_studies: () => sql`id = ${a.draftId}`,
    projects: () => sql`tenant_id = ${a.tenantId}`,
  };
  const links = (count: number) =>
    JSON.stringify(Array.from({ length: count }, () => ({ label: 'x', url: 'https://x.example' })));
  const link = (item: unknown) => sql`links = ${JSON.stringify([item])}::jsonb`;
  const tags = (count: number) => Array.from({ length: count }, (_, index) => `t${index}`);
  const tagged = (values: (string | null)[]) => sql`tags = ${sql.param(values)}::text[]`;
  const site = 'https://ines.example';
  const longUrl = (length: number) => `${site}/${'x'.repeat(length - site.length - 1)}`;

  async function attempt(table: TableName, change: SQL) {
    const rollback = new Error('rollback');
    const outcome = await asOwner(a, async (tx) => {
      const updated = await tx.execute(
        sql`update ${tables[table]} set ${change} where ${rowOf[table]()}`,
      );
      expect(updated.rowCount).toBe(1);
      throw rollback;
    }).catch((error: unknown) => error);
    if (outcome === rollback) return 'accepted';
    expect(outcome).toMatchObject({ cause: { code: '23514' } });
    return constraintOf(outcome);
  }

  function constraintOf(error: unknown): unknown {
    if (typeof error !== 'object' || error === null || !('cause' in error)) return error;
    const { cause } = error;
    if (typeof cause !== 'object' || cause === null || !('constraint' in cause)) return cause;
    return cause.constraint;
  }

  it.each([
    ['profiles', 'bio_md', LIMITS.bioMd],
    ['experiences', 'summary_md', LIMITS.summaryMd],
    ['case_studies', 'body_md', LIMITS.bodyMd],
  ] as const)('holds %s.%s to its length and to the fence cap', async (table, column, max) => {
    const set = (value: string) => sql`${sql.identifier(column)} = ${value}`;
    expect(await attempt(table, set('x'.repeat(max)))).toBe('accepted');
    expect(await attempt(table, set('x'.repeat(max + 1)))).toBe(`${table}_length_check`);
    expect(await attempt(table, set(fences(LIMITS.markdownFences)))).toBe('accepted');
    expect(await attempt(table, set(':'.repeat(3 * LIMITS.markdownFences + 2)))).toBe('accepted');
    for (const value of [
      fences(LIMITS.markdownFences + 1),
      ':'.repeat(3 * LIMITS.markdownFences + 3),
    ]) {
      expect(await attempt(table, set(value))).toBe(`${table}_${column}_fences_check`);
    }
  });

  it.each([
    [
      'profiles',
      'profiles_length_check',
      () => sql`display_name = ${'x'.repeat(LIMITS.displayName + 1)}`,
    ],
    ['profiles', 'profiles_links_check', () => sql`links = '{}'::jsonb`],
    ['profiles', 'profiles_links_check', () => sql`links = '"x"'::jsonb`],
    ['profiles', 'profiles_links_check', () => sql`links = ${links(LIMITS.links + 1)}::jsonb`],
    ['profiles', 'profiles_links_items_check', () => link('https://ines.example')],
    ['profiles', 'profiles_links_items_check', () => link({ label: 'Site' })],
    ['profiles', 'profiles_links_items_check', () => link({ url: site })],
    ['profiles', 'profiles_links_items_check', () => link({ label: null, url: site })],
    ['profiles', 'profiles_links_items_check', () => link({ label: 7, url: site })],
    ['profiles', 'profiles_links_items_check', () => link({ label: 'Site', url: [site] })],
    ['profiles', 'profiles_links_items_check', () => link({ label: '', url: site })],
    [
      'profiles',
      'profiles_links_items_check',
      () => link({ label: 'x'.repeat(LIMITS.linkLabel + 1), url: site }),
    ],
    [
      'profiles',
      'profiles_links_items_check',
      () => link({ label: 'Site', url: 'javascript:alert(1)' }),
    ],
    ['profiles', 'profiles_links_items_check', () => link({ label: 'Site', url: 'http://x.test' })],
    ['profiles', 'profiles_links_items_check', () => link({ label: 'Site', url: 'data:,x' })],
    ['profiles', 'profiles_links_items_check', () => link({ label: 'Site', url: 'https://' })],
    ['profiles', 'profiles_links_items_check', () => link({ label: 'Site', url: `${site} x` })],
    ['profiles', 'profiles_links_items_check', () => link({ label: 'Site', url: `${site}/\t` })],
    [
      'profiles',
      'profiles_links_items_check',
      () => link({ label: 'Site', url: 'https://inés.example' }),
    ],
    [
      'profiles',
      'profiles_links_items_check',
      () => link({ label: 'Site', url: longUrl(LIMITS.url + 1) }),
    ],
    [
      'profiles',
      'profiles_links_items_check',
      () => link({ label: 'Site', url: site, padding: 'x'.repeat(5_000) }),
    ],
    ['experiences', 'experiences_dates_check', () => sql`ends_on = starts_on - 1`],
    [
      'experiences',
      'experiences_length_check',
      () => sql`company = ${'x'.repeat(LIMITS.company + 1)}`,
    ],
    ['case_studies', 'case_studies_slug_check', () => sql`slug = 'Not A Slug'`],
    ['case_studies', 'case_studies_slug_check', () => sql`slug = ${'a'.repeat(LIMITS.slug + 1)}`],
    [
      'case_studies',
      'case_studies_length_check',
      () => sql`title = ${'x'.repeat(LIMITS.title + 1)}`,
    ],
    ['projects', 'projects_url_check', () => sql`url = 'http://ledger.example'`],
    ['projects', 'projects_url_check', () => sql`url = ${`${site}/a b`}`],
    ['projects', 'projects_url_check', () => sql`url = ${`${site}/\u007f`}`],
    ['projects', 'projects_url_check', () => sql`url = ${longUrl(LIMITS.url + 1)}`],
    ['projects', 'projects_repo_url_check', () => sql`repo_url = 'javascript:alert(1)'`],
    ['projects', 'projects_repo_url_check', () => sql`repo_url = ${`${site}/x\n`}`],
    ['projects', 'projects_repo_url_check', () => sql`repo_url = 'https://inés.example'`],
    [
      'projects',
      'projects_tags_check',
      () => sql`tags = ${sql.param(tags(LIMITS.tags + 1))}::text[]`,
    ],
    ['projects', 'projects_tags_check', () => sql`tags = '{{postgres,rls}}'::text[]`],
    ['projects', 'projects_tags_check', () => sql`tags = '[0:1]={postgres,rls}'::text[]`],
    ['projects', 'projects_tags_check', () => sql`tags = '[2:2]={postgres}'::text[]`],
    ['projects', 'projects_tags_items_check', () => tagged(['postgres', null])],
    ['projects', 'projects_tags_items_check', () => tagged([''])],
    ['projects', 'projects_tags_items_check', () => tagged(['x'.repeat(LIMITS.tag + 1)])],
    ['projects', 'projects_length_check', () => sql`name = ${'x'.repeat(LIMITS.projectName + 1)}`],
  ] as const)('refuses a bad %s value by %s', async (table, constraint, change) => {
    expect(await attempt(table, change())).toBe(constraint);
  });

  it.each([
    ['profiles', () => sql`links = ${links(LIMITS.links)}::jsonb`],
    ['experiences', () => sql`ends_on = starts_on`],
    ['case_studies', () => sql`slug = ${'a'.repeat(LIMITS.slug)}`],
    ['projects', () => sql`url = 'https://ledger.example', repo_url = null`],
    ['projects', () => sql`url = ${longUrl(LIMITS.url)}, repo_url = ${longUrl(LIMITS.url)}`],
    ['projects', () => sql`tags = ${sql.param(tags(LIMITS.tags))}::text[]`],
    ['profiles', () => link({ label: 'x'.repeat(LIMITS.linkLabel), url: longUrl(LIMITS.url) })],
    ['profiles', () => link({ label: 'Mail', url: 'mailto:ines@example.test' })],
    ['projects', () => tagged(['x'.repeat(LIMITS.tag)])],
    ['projects', () => tagged([])],
  ] as const)('accepts a %s value on the bound', async (table, change) => {
    expect(await attempt(table, change())).toBe('accepted');
  });
});
