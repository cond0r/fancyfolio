import { type CaseStudy, type SiteBundle, siteBundle } from '@fancyfolio/contracts';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect } from '../../../../packages/db/src/client.ts';
import {
  caseStudies,
  domains,
  experiences,
  profiles,
  projects,
} from '../../../../packages/db/src/schema/content.ts';
import { withTenant } from '../../../../packages/db/src/with-tenant.ts';
import {
  createTenant,
  createUser,
  deleteUsers,
  requireWritable,
} from '../../../../packages/db/test/fixtures.ts';
import type {} from '../../../../packages/db/test/setup.ts';

const { appUrl, authUrl } = inject('db');
vi.stubEnv('DATABASE_URL', appUrl);
const { default: api } = await import('../../src/index.ts');

const app = connect(appUrl);
const auth = connect(authUrl);
const db = drizzle(app);
const amara = { userId: '', tenantId: '' };
const kenji = { userId: '', tenantId: '' };
const lena = { userId: '', tenantId: '' };
const omar = { userId: '', tenantId: '' };
const nadia = { userId: '', tenantId: '' };
let expected: SiteBundle;
let billing: CaseStudy;

function token(seed: string): string {
  return seed.repeat(43);
}

function asOwner<T>(owner: typeof amara, fn: Parameters<typeof withTenant<T>>[2]) {
  return withTenant(db, { kind: 'user', userId: owner.userId }, fn);
}

beforeAll(async () => {
  requireWritable();
  amara.userId = await createUser(auth, 'Amara Diallo', 'amara.sites@example.test');
  kenji.userId = await createUser(auth, 'Kenji Mori', 'kenji.sites@example.test');
  lena.userId = await createUser(auth, 'Lena Fischer', 'lena.sites@example.test');
  omar.userId = await createUser(auth, 'Omar Haddad', 'omar.sites@example.test');
  nadia.userId = await createUser(auth, 'Nadia Okafor', 'nadia.sites@example.test');
  amara.tenantId = await createTenant(db, amara.userId, 'amara-sites');
  kenji.tenantId = await createTenant(db, kenji.userId, 'kenji-sites');
  lena.tenantId = await createTenant(db, lena.userId, 'lena-sites');
  omar.tenantId = await createTenant(db, omar.userId, 'omar-sites');
  nadia.tenantId = await createTenant(db, nadia.userId, 'nadia-sites');

  expected = await asOwner(amara, async (tx) => {
    const [profile] = await tx
      .insert(profiles)
      .values({
        tenantId: amara.tenantId,
        displayName: 'Amara Diallo',
        headline: 'Staff engineer',
        location: 'Lisbon',
        bioMd: 'Builds **billing** systems.',
        links: [{ label: 'Site', url: 'https://amara.example.test' }],
      })
      .returning({
        displayName: profiles.displayName,
        headline: profiles.headline,
        location: profiles.location,
        bioMd: profiles.bioMd,
        avatarUrl: profiles.avatarUrl,
        links: profiles.links,
      });
    const experience = {
      id: experiences.id,
      company: experiences.company,
      role: experiences.role,
      location: experiences.location,
      startsOn: experiences.startsOn,
      endsOn: experiences.endsOn,
      summaryMd: experiences.summaryMd,
    };
    const [past] = await tx
      .insert(experiences)
      .values({
        tenantId: amara.tenantId,
        company: 'Contoso Analytics',
        role: 'Senior engineer',
        startsOn: '2019-01-01',
        endsOn: '2022-02-28',
      })
      .returning(experience);
    const [current] = await tx
      .insert(experiences)
      .values({
        tenantId: amara.tenantId,
        company: 'Northwind Labs',
        role: 'Staff engineer',
        startsOn: '2022-03-01',
        summaryMd: 'Leads the platform team.',
      })
      .returning(experience);
    const project = {
      id: projects.id,
      name: projects.name,
      description: projects.description,
      url: projects.url,
      repoUrl: projects.repoUrl,
      tags: projects.tags,
    };
    const [older] = await tx
      .insert(projects)
      .values({ tenantId: amara.tenantId, name: 'Ledger', createdAt: '2024-01-01 00:00:00+00' })
      .returning(project);
    const [newer] = await tx
      .insert(projects)
      .values({
        tenantId: amara.tenantId,
        name: 'Queue lab',
        description: 'A queue playground.',
        url: 'https://queue.example.test',
        repoUrl: 'https://git.example.test/amara/queue',
        tags: ['postgres', 'queues'],
        createdAt: '2025-01-01 00:00:00+00',
      })
      .returning(project);
    const card = {
      slug: caseStudies.slug,
      title: caseStudies.title,
      summary: caseStudies.summary,
      coverUrl: caseStudies.coverUrl,
      experienceId: caseStudies.experienceId,
      publishedAt: caseStudies.publishedAt,
      updatedAt: caseStudies.updatedAt,
    };
    const [search] = await tx
      .insert(caseStudies)
      .values({
        tenantId: amara.tenantId,
        slug: 'search-revamp',
        title: 'Search revamp',
        publishedAt: '2026-09-01 08:00:00+00',
      })
      .returning(card);
    const [billingCard] = await tx
      .insert(caseStudies)
      .values({
        tenantId: amara.tenantId,
        slug: 'billing-rewrite',
        title: 'Billing rewrite',
        summary: 'From cron jobs to a ledger.',
        bodyMd: '# Billing\n\nIt worked.',
        experienceId: current.id,
        publishedAt: '2026-10-01 10:00:00.123456+00',
      })
      .returning({ ...card, bodyMd: caseStudies.bodyMd });
    billing = billingCard as CaseStudy;
    await tx.insert(caseStudies).values({
      tenantId: amara.tenantId,
      slug: 'secret-draft',
      title: 'Secret draft',
      bodyMd: 'not public',
    });
    await tx.insert(domains).values({
      tenantId: amara.tenantId,
      hostname: 'amara.example.test',
      challengeToken: token('a'),
      verifiedAt: sql`now()`,
      checkedAt: sql`now()`,
    });
    const { bodyMd: _body, ...billingListed } = billing;
    return {
      tenantId: amara.tenantId,
      subdomain: 'amara-sites',
      domain: 'amara.example.test',
      profile: profile as SiteBundle['profile'],
      experiences: [current, past],
      projects: [newer, older],
      caseStudies: [billingListed, search] as SiteBundle['caseStudies'],
    };
  });

  await asOwner(kenji, async (tx) => {
    await tx.insert(profiles).values({ tenantId: kenji.tenantId, displayName: 'Kenji Mori' });
    await tx.insert(caseStudies).values({
      tenantId: kenji.tenantId,
      slug: 'kenji-only',
      title: 'Kenji only',
      publishedAt: '2026-08-01 08:00:00+00',
    });
    await tx.insert(domains).values({
      tenantId: kenji.tenantId,
      hostname: 'amara.example.test',
      challengeToken: token('k'),
    });
  });
  await asOwner(lena, async (tx) => {
    await tx.insert(profiles).values({ tenantId: lena.tenantId, displayName: 'Lena Fischer' });
    await tx.insert(domains).values({
      tenantId: lena.tenantId,
      hostname: 'lena.example.test',
      challengeToken: token('l'),
      verifiedAt: sql`now() - interval '10 days'`,
      checkedAt: sql`now() - interval '73 hours'`,
    });
  });
  await asOwner(omar, async (tx) => {
    await tx.insert(caseStudies).values({
      tenantId: omar.tenantId,
      slug: 'omar-study',
      title: 'Omar study',
      publishedAt: '2026-07-01 08:00:00+00',
    });
  });
});

afterAll(async () => {
  await deleteUsers(auth, [amara.userId, kenji.userId, lena.userId, omar.userId, nadia.userId]);
  await Promise.all([app.end(), auth.end()]);
});

async function get(path: string) {
  const res = await api.request(path);
  return { status: res.status, body: await res.json() };
}

const notFound = { status: 404, body: { error: 'Not found', requestId: expect.any(String) } };

async function rows() {
  return Promise.all(
    [amara, kenji, lena, omar].map((owner) =>
      asOwner(owner, async (tx) => ({
        domains: await tx.execute(sql`select * from domains order by id`),
        caseStudies: await tx.execute(sql`select * from case_studies order by id`),
        profiles: await tx.execute(sql`select * from profiles`),
        experiences: await tx.execute(sql`select * from experiences order by id`),
        projects: await tx.execute(sql`select * from projects order by id`),
      })),
    ),
  );
}

describe('GET /api/v1/sites/:key', () => {
  it('returns the bundle by subdomain: published cards only, newest first', async () => {
    const res = await get('/api/v1/sites/amara-sites');
    expect(res.status).toBe(200);
    expect(v.is(siteBundle, res.body)).toBe(true);
    expect(res.body).toEqual(expected);
    expect(JSON.stringify(res.body)).not.toContain('secret-draft');
  });

  it('returns the same bundle by the live custom domain', async () => {
    expect(await get('/api/v1/sites/amara.example.test')).toEqual({ status: 200, body: expected });
  });

  it('names no custom domain when the tenant has only an unverified or a lapsed one', async () => {
    expect(await get('/api/v1/sites/kenji-sites')).toMatchObject({
      status: 200,
      body: { tenantId: kenji.tenantId, domain: null },
    });
    expect(await get('/api/v1/sites/lena-sites')).toMatchObject({
      status: 200,
      body: { tenantId: lena.tenantId, domain: null },
    });
  });

  it.each([
    ['an unknown subdomain', 'nobody'],
    ['an unknown hostname', 'nobody.example.test'],
    ['a lapsed domain', 'lena.example.test'],
    ['a look-alike ACE hostname', 'xn--amra-xqa.example.test'],
    ['a subdomain of the live domain', 'www.amara.example.test'],
    ['a parent of the live domain', 'example.test'],
    ['a tenant without a profile', 'omar-sites'],
    ['a path that normalizes to another key', 'amara-sites/../health'],
  ])('gives 404 for %s', async (_name, key) => {
    expect(await get(`/api/v1/sites/${key}`)).toEqual(notFound);
  });

  it('serves concurrent reads of different sites each their own bundle', async () => {
    const [first, second] = await Promise.all([
      get('/api/v1/sites/amara-sites'),
      get('/api/v1/sites/kenji-sites'),
    ]);
    expect(first.body).toEqual(expected);
    expect(second.body.tenantId).toBe(kenji.tenantId);
    expect(second.body.caseStudies.map((card: { slug: string }) => card.slug)).toEqual([
      'kenji-only',
    ]);
  });

  it('reads the whole bundle from one snapshot while an owner commits between its queries', async () => {
    await asOwner(nadia, async (tx) => {
      await tx.insert(profiles).values({ tenantId: nadia.tenantId, displayName: 'Nadia Okafor' });
      await tx.insert(caseStudies).values({
        tenantId: nadia.tenantId,
        slug: 'snapshot',
        title: 'Snapshot',
        publishedAt: sql`now()`,
      });
    });
    const pending = await asOwner(nadia, async (tx) => {
      await tx.execute(sql`lock table case_studies in access exclusive mode`);
      const read = get('/api/v1/sites/nadia-sites');
      await vi.waitFor(
        async () => {
          const [blocked] = await app<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and query ilike '%case_studies%'
          `;
          expect(blocked.n).toBe(1);
        },
        { timeout: 1_500, interval: 10 },
      );
      const [joined] = await tx
        .insert(experiences)
        .values({
          tenantId: nadia.tenantId,
          company: 'Fabrikam',
          role: 'Engineer',
          startsOn: '2020-01-01',
        })
        .returning({ id: experiences.id });
      await tx
        .update(caseStudies)
        .set({ experienceId: joined.id })
        .where(eq(caseStudies.slug, 'snapshot'));
      return { read };
    });
    const res = await pending.read;
    expect(res.status).toBe(200);
    expect({
      experiences: res.body.experiences,
      experienceIds: res.body.caseStudies.map((card: CaseStudy) => card.experienceId),
    }).toEqual({ experiences: [], experienceIds: [null] });
  });
});

describe('GET /api/v1/sites/:key/case-studies/:slug', () => {
  it('returns a published case study by subdomain and by live domain', async () => {
    for (const key of ['amara-sites', 'amara.example.test']) {
      expect(await get(`/api/v1/sites/${key}/case-studies/billing-rewrite`)).toEqual({
        status: 200,
        body: billing,
      });
    }
  });

  it.each([
    ['a draft', 'amara-sites', 'secret-draft'],
    ['another tenant’s slug', 'amara-sites', 'kenji-only'],
    ['an unknown slug', 'amara-sites', 'nothing-here'],
    ['an unknown site', 'nobody', 'billing-rewrite'],
    ['a lapsed domain', 'lena.example.test', 'billing-rewrite'],
    ['a published case study of a tenant without a profile', 'omar-sites', 'omar-study'],
  ])('gives 404 for %s', async (_name, key, slug) => {
    expect(await get(`/api/v1/sites/${key}/case-studies/${slug}`)).toEqual(notFound);
  });
});

describe('the public routes only read', () => {
  it('leave every row as it was after reads, refusals and other methods', async () => {
    const before = await rows();
    for (const key of ['amara-sites', 'amara.example.test', 'kenji-sites', 'lena.example.test']) {
      await api.request(`/api/v1/sites/${key}`);
      await api.request(`/api/v1/sites/${key}/case-studies/billing-rewrite`);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of [
        '/api/v1/sites/amara-sites',
        '/api/v1/sites/amara-sites/case-studies/billing-rewrite',
      ]) {
        const res = await api.request(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Forged', publishedAt: null }),
        });
        expect(res.status).toBe(404);
      }
    }
    expect(await rows()).toEqual(before);
    expect(before[0].domains).toHaveLength(1);
    expect(before[0].caseStudies).toHaveLength(3);
    expect(before[2].domains).toHaveLength(1);
  });
});
