import * as v from 'valibot';
import { LIMITS } from './limits.ts';
import { isHostname, isSlug, isSubdomain } from './predicates.ts';

export const siteKey = v.pipe(
  v.string(),
  v.check((key) => isSubdomain(key) || isHostname(key)),
  v.description('A subdomain or the live custom domain of a site'),
);
export const caseStudySlug = v.pipe(
  v.string(),
  v.check(isSlug),
  v.description(
    `Lower-case letters and digits in hyphen-separated groups, at most ${LIMITS.slug} characters`,
  ),
);

export const siteParams = v.strictObject({ key: siteKey });
export const caseStudyParams = v.strictObject({ key: siteKey, slug: caseStudySlug });

const text = v.string();
const optionalText = v.nullable(v.string());

export const caseStudyCard = v.strictObject({
  slug: text,
  title: text,
  summary: text,
  coverUrl: optionalText,
  experienceId: optionalText,
  publishedAt: text,
  updatedAt: text,
});

export const caseStudy = v.pipe(
  v.strictObject({ ...caseStudyCard.entries, bodyMd: text }),
  v.metadata({ ref: 'CaseStudy' }),
);

export const siteBundle = v.pipe(
  v.strictObject({
    tenantId: text,
    subdomain: text,
    domain: optionalText,
    profile: v.strictObject({
      displayName: text,
      headline: text,
      location: text,
      bioMd: text,
      avatarUrl: optionalText,
      links: v.array(v.strictObject({ label: text, url: text })),
    }),
    experiences: v.array(
      v.strictObject({
        id: text,
        company: text,
        role: text,
        location: text,
        startsOn: text,
        endsOn: optionalText,
        summaryMd: text,
      }),
    ),
    projects: v.array(
      v.strictObject({
        id: text,
        name: text,
        description: text,
        url: optionalText,
        repoUrl: optionalText,
        tags: v.array(text),
      }),
    ),
    caseStudies: v.array(caseStudyCard),
  }),
  v.metadata({ ref: 'SiteBundle' }),
);

export type CaseStudyCard = v.InferOutput<typeof caseStudyCard>;
export type CaseStudy = v.InferOutput<typeof caseStudy>;
export type SiteBundle = v.InferOutput<typeof siteBundle>;
