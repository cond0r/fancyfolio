import { caseStudy, caseStudyParams, siteBundle, siteParams } from '@fancyfolio/contracts';
import {
  caseStudies,
  domains,
  experiences,
  profiles,
  projects,
  type TenantTransaction,
  tenants,
} from '@fancyfolio/db';
import { asc, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as v from 'valibot';
import { db } from '../db.ts';
import { type Env, notFound, pathParams } from '../shell.ts';

const card = {
  slug: caseStudies.slug,
  title: caseStudies.title,
  summary: caseStudies.summary,
  coverUrl: caseStudies.coverUrl,
  experienceId: caseStudies.experienceId,
  publishedAt: caseStudies.publishedAt,
  updatedAt: caseStudies.updatedAt,
};

function readSite<T>(key: string, read: (tx: TenantTransaction) => Promise<T>) {
  return db.withTenant({ kind: 'site', site: key }, async (tx, tenantId) => {
    if (tenantId === null) return null;
    const [[site], value] = await Promise.all([
      tx
        .select({
          subdomain: tenants.subdomain,
          profile: {
            displayName: profiles.displayName,
            headline: profiles.headline,
            location: profiles.location,
            bioMd: profiles.bioMd,
            avatarUrl: profiles.avatarUrl,
            links: profiles.links,
          },
        })
        .from(tenants)
        .innerJoin(profiles, eq(profiles.tenantId, tenants.id)),
      read(tx),
    ]);
    return site === undefined ? null : { tenantId, ...site, value };
  });
}

export const sites = new Hono<Env>()
  .get('/:key', pathParams(siteParams), async (c) => {
    const site = await readSite(c.req.valid('param').key, (tx) =>
      Promise.all([
        tx.select({ hostname: domains.hostname }).from(domains),
        tx
          .select({
            id: experiences.id,
            company: experiences.company,
            role: experiences.role,
            location: experiences.location,
            startsOn: experiences.startsOn,
            endsOn: experiences.endsOn,
            summaryMd: experiences.summaryMd,
          })
          .from(experiences)
          .orderBy(desc(experiences.startsOn), asc(experiences.id)),
        tx
          .select({
            id: projects.id,
            name: projects.name,
            description: projects.description,
            url: projects.url,
            repoUrl: projects.repoUrl,
            tags: projects.tags,
          })
          .from(projects)
          .orderBy(desc(projects.createdAt), asc(projects.id)),
        tx
          .select(card)
          .from(caseStudies)
          .orderBy(desc(caseStudies.publishedAt), asc(caseStudies.slug)),
      ]),
    );
    if (site === null) return notFound(c);
    const [[domain], experienceRows, projectRows, cards] = site.value;
    return c.json(
      v.parse(siteBundle, {
        tenantId: site.tenantId,
        subdomain: site.subdomain,
        domain: domain?.hostname ?? null,
        profile: site.profile,
        experiences: experienceRows,
        projects: projectRows,
        caseStudies: cards,
      }),
    );
  })
  .get('/:key/case-studies/:slug', pathParams(caseStudyParams), async (c) => {
    const { key, slug } = c.req.valid('param');
    const site = await readSite(key, (tx) =>
      tx
        .select({ ...card, bodyMd: caseStudies.bodyMd })
        .from(caseStudies)
        .where(eq(caseStudies.slug, slug)),
    );
    const found = site?.value[0];
    return found === undefined ? notFound(c) : c.json(v.parse(caseStudy, found));
  });
