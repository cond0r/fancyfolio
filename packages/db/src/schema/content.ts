import { HTTPS_URL_PATTERN, LIMITS, MARKDOWN_FENCE, SLUG_PATTERN } from '@fancyfolio/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.ts';

const BLOB_URL_PATTERN =
  '^https://[a-z0-9]+\\.public\\.blob\\.vercel-storage\\.com/tenants/[0-9a-f-]{36}/[A-Za-z0-9_-]+\\.(png|jpe?g|webp)$';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull();

function lengthCheck(name: string, columns: [AnyPgColumn, number][]) {
  const clauses = columns.map(([column, max]) => sql`char_length(${column}) <= ${max}`);
  return check(name, sql.join(clauses, sql` and `).inlineParams());
}

function fenceCheck(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`(length(${column}) - length(replace(${column}, ${MARKDOWN_FENCE}, ''))) / ${MARKDOWN_FENCE.length} <= ${LIMITS.markdownFences}`.inlineParams(),
  );
}

function httpsUrlCheck(name: string, url: AnyPgColumn) {
  return check(
    name,
    sql`char_length(${url}) <= ${LIMITS.url} and ${url} ~ ${HTTPS_URL_PATTERN}`.inlineParams(),
  );
}

function blobUrlCheck(name: string, url: AnyPgColumn, tenant: AnyPgColumn) {
  return check(
    name,
    sql`${url} ~ ${BLOB_URL_PATTERN} and split_part(${url}, '/', 5) = ${tenant}::text`.inlineParams(),
  );
}

export const profiles = pgTable(
  'profiles',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull().default(''),
    headline: text('headline').notNull().default(''),
    location: text('location').notNull().default(''),
    bioMd: text('bio_md').notNull().default(''),
    avatarUrl: text('avatar_url'),
    links: jsonb('links').notNull().default([]),
    updatedAt: updatedAt(),
  },
  (table) => [
    lengthCheck('profiles_length_check', [
      [table.displayName, LIMITS.displayName],
      [table.headline, LIMITS.headline],
      [table.location, LIMITS.location],
      [table.bioMd, LIMITS.bioMd],
      [table.avatarUrl, LIMITS.url],
    ]),
    fenceCheck('profiles_bio_md_fences_check', table.bioMd),
    blobUrlCheck('profiles_avatar_url_check', table.avatarUrl, table.tenantId),
    check(
      'profiles_links_check',
      sql`case jsonb_typeof(${table.links}) when 'array' then jsonb_array_length(${table.links}) <= ${LIMITS.links} else false end`.inlineParams(),
    ),
  ],
);

export const experiences = pgTable(
  'experiences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    company: text('company').notNull(),
    role: text('role').notNull(),
    location: text('location').notNull().default(''),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
    summaryMd: text('summary_md').notNull().default(''),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('experiences_tenant_id_id_unique').on(table.tenantId, table.id),
    index('experiences_tenant_id_starts_on_idx').on(table.tenantId, table.startsOn.desc()),
    lengthCheck('experiences_length_check', [
      [table.company, LIMITS.company],
      [table.role, LIMITS.role],
      [table.location, LIMITS.location],
      [table.summaryMd, LIMITS.summaryMd],
    ]),
    fenceCheck('experiences_summary_md_fences_check', table.summaryMd),
    check('experiences_dates_check', sql`${table.endsOn} >= ${table.startsOn}`),
  ],
);

export const caseStudies = pgTable(
  'case_studies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    bodyMd: text('body_md').notNull().default(''),
    coverUrl: text('cover_url'),
    experienceId: uuid('experience_id'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
    sourceHash: text('source_hash'),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('case_studies_tenant_id_slug_unique').on(table.tenantId, table.slug),
    index('case_studies_tenant_id_experience_id_idx').on(table.tenantId, table.experienceId),
    check(
      'case_studies_slug_check',
      sql`char_length(${table.slug}) <= ${LIMITS.slug} and ${table.slug} ~ ${SLUG_PATTERN}`.inlineParams(),
    ),
    lengthCheck('case_studies_length_check', [
      [table.title, LIMITS.title],
      [table.summary, LIMITS.summary],
      [table.bodyMd, LIMITS.bodyMd],
      [table.coverUrl, LIMITS.url],
    ]),
    fenceCheck('case_studies_body_md_fences_check', table.bodyMd),
    blobUrlCheck('case_studies_cover_url_check', table.coverUrl, table.tenantId),
    check('case_studies_source_hash_check', sql`${table.sourceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    url: text('url'),
    repoUrl: text('repo_url'),
    tags: text('tags').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('projects_tenant_id_created_at_idx').on(table.tenantId, table.createdAt.desc()),
    lengthCheck('projects_length_check', [
      [table.name, LIMITS.projectName],
      [table.description, LIMITS.description],
    ]),
    httpsUrlCheck('projects_url_check', table.url),
    httpsUrlCheck('projects_repo_url_check', table.repoUrl),
    check(
      'projects_tags_check',
      sql`cardinality(${table.tags}) <= ${LIMITS.tags} and (cardinality(${table.tags}) = 0 or array_ndims(${table.tags}) = 1 and array_lower(${table.tags}, 1) = 1)`.inlineParams(),
    ),
  ],
);
