import {
  isChallengeToken,
  isHostname,
  isHttpsUrl,
  isLinkUrl,
  isSlug,
  withinFenceLimit,
} from '@fancyfolio/contracts';
import { getTableName, type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';
import { caseStudies, domains, experiences, profiles, projects } from '../src/schema/content.ts';

const { appUrl, ownerUrl } = inject('db');
const app = connect(appUrl);
const owner = connect(ownerUrl);
const db = drizzle(app);
const contentTables = [profiles, experiences, caseStudies, projects, domains];

afterAll(() => Promise.all([app.end(), owner.end()]));

const probes = [..."az09-AZ_.:/@%' \n\t\\", 'é', 'а', 'ı', '​', 'ａ', '．', '\u{1f600}'];
const around = (base: string) =>
  probes.flatMap((probe) => [
    `${probe}${base}`,
    `${base.slice(0, 2)}${probe}${base.slice(2)}`,
    `${base}${probe}`,
  ]);

const slugs = [
  ...new Set([
    'billing-rewrite',
    'a',
    '1',
    'a-b-c',
    'a--b',
    '-a',
    'a-',
    '../billing',
    '%2e%2e',
    "a'); drop table case_studies; --",
    ...Array.from({ length: 70 }, (_, index) => 'a'.repeat(index + 1)),
    ...Array.from({ length: 70 }, (_, index) => `${'a'.repeat(index)}-b`),
    ...around('billing'),
  ]),
];

const label = (length: number) => 'a'.repeat(length);
const hostnames = [
  ...new Set([
    'ines.example',
    'a.b',
    'xn--80ak6aa92e.example',
    'ines.xn--p1ai',
    '1password.example',
    'localhost',
    '127.0.0.1',
    '127.1',
    '0x7f.1',
    '[::1]',
    'ines.123',
    '*.vercel.app',
    'ines.example:443',
    'user@ines.example',
    'https://ines.example',
    'ines..example',
    '.ines.example',
    'ines.example.',
    '%.example',
    ...Array.from({ length: 6 }, (_, index) => `${label(61 + index)}.example`),
    ...[57, 58, 59, 60].map(
      (last) => `${[label(63), label(63), label(63), label(last)].join('.')}.ab`,
    ),
    ...around('ines.example'),
    ...around('ines.example').map((value) => value.toUpperCase()),
  ]),
];

const markdown = [
  ...new Set([
    '',
    'plain text',
    ...Array.from({ length: 16 }, (_, count) => ':::note\n'.repeat(count)),
    ...Array.from({ length: 40 }, (_, count) => ':'.repeat(count)),
    ...Array.from({ length: 12 }, (_, count) => '::::'.repeat(count)),
    ...Array.from({ length: 12 }, (_, count) => `é\u{1f600}:::`.repeat(count)),
    ':: : ::'.repeat(20),
  ]),
];

const site = 'https://ines.example';
const urlOf = (length: number) => `${site}/${'x'.repeat(length - site.length - 1)}`;
const urls = [
  ...new Set([
    site,
    `${site}/notes?tag=postgres#rls`,
    `${site}/caf%C3%A9`,
    'https://',
    'mailto:',
    'mailto:ines@example.test',
    'http://ines.example',
    'HTTPS://ines.example',
    'javascript:alert(1)',
    'data:,x',
    '//ines.example',
    'https://inés.example',
    ...['\u0001', '\u007f', '\u0085', '\u00a0', '\u2028', '\u3000', '\ufeff'].map(
      (character) => `${site}/${character}`,
    ),
    ...[2047, 2048, 2049, 2050].map(urlOf),
    ...around(site),
    ...around('mailto:ines@example.test'),
  ]),
];
const urlPieces = [
  'https://',
  'https:',
  'mailto:',
  'http://',
  '//',
  'ines',
  '.example',
  '/',
  '?q=1',
  '#',
  '%20',
  '~',
  '\u007f',
  '\u0085',
  '\u00a0',
  '\u2028',
  '\ufeff',
  ...probes,
];

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function generated(seed: number, pieces: string[], maxPieces: number, count = 3_000) {
  const random = seeded(seed);
  const pick = (length: number) => Math.floor(random() * length);
  return Array.from({ length: count }, () =>
    Array.from({ length: pick(maxPieces + 1) }, () => pieces[pick(pieces.length)]).join(''),
  );
}

function tokens(seed: number, count = 3_000) {
  const random = seeded(seed);
  const pick = (characters: string) => characters[Math.floor(random() * characters.length)];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from({ length: count }, () => {
    const length = 38 + Math.floor(random() * 32);
    const token = Array.from({ length }, () => pick(alphabet)).join('');
    if (random() < 0.5) return token;
    const at = Math.floor(random() * (length + 1));
    return `${token.slice(0, at)}${pick("+/= \n.%'éａ")}${token.slice(at)}`;
  });
}

const sweeps = [
  {
    what: 'slug',
    table: caseStudies,
    column: 'slug',
    name: 'case_studies_slug_check',
    corpus: generated(1, [...'abz09', ...'---', ...probes], 70),
    contract: isSlug,
  },
  {
    what: 'hostname',
    table: domains,
    column: 'hostname',
    name: 'domains_hostname_check',
    corpus: generated(
      2,
      [
        'ines',
        'a-b',
        'z',
        '0',
        '-',
        '.',
        '.example',
        '.example',
        'xn--',
        'a'.repeat(30),
        ...probes,
      ],
      12,
    ),
    contract: isHostname,
  },
  {
    what: 'markdown body',
    table: caseStudies,
    column: 'body_md',
    name: 'case_studies_body_md_fences_check',
    corpus: generated(3, [':', '::', ':::', '::::', 'a', ' ', '\n', 'é', '\u{1f600}'], 60),
    contract: withinFenceLimit,
  },
  {
    what: 'project URL',
    table: projects,
    column: 'url',
    name: 'projects_url_check',
    corpus: generated(4, urlPieces, 8),
    contract: isHttpsUrl,
  },
  {
    what: 'challenge token',
    table: domains,
    column: 'challenge_token',
    name: 'domains_challenge_token_check',
    corpus: tokens(6),
    contract: isChallengeToken,
  },
] as const;

async function installed(table: PgTable, name: string): Promise<SQL> {
  const {
    rows: [row],
  } = await db.execute<{ definition: string }>(
    sql`select pg_get_constraintdef(oid) as definition from pg_constraint where contype = 'c' and conname = ${name} and conrelid = ${`public.${getTableName(table)}`}::regclass`,
  );
  if (row === undefined) throw new Error(`no CHECK named ${name}`);
  return sql.raw(row.definition.replace(/^CHECK /, ''));
}

async function disagreements(
  table: PgTable,
  column: string,
  name: string,
  corpus: string[],
  contract: (value: string) => boolean,
) {
  return verdictsDiffer(
    sql`select ${sql.identifier(column)} as value, coalesce(${await installed(table, name)}, true) as accepted from unnest(${sql.param(corpus)}::text[]) as ${sql.identifier(getTableName(table))}(${sql.identifier(column)})`,
    corpus,
    contract,
  );
}

function linkDisagreements(corpus: string[]) {
  return verdictsDiffer(
    sql`select url as value, app.links_valid(jsonb_build_array(jsonb_build_object('label', 'Site', 'url', url))) as accepted from unnest(${sql.param(corpus)}::text[]) as link(url)`,
    corpus,
    isLinkUrl,
  );
}

async function verdictsDiffer(query: SQL, corpus: string[], contract: (value: string) => boolean) {
  const { rows } = await db.execute<{ value: string; accepted: boolean }>(query);
  const verdicts = rows.map(({ value, accepted }) => ({
    value,
    contract: contract(value),
    database: accepted,
  }));
  expect(verdicts.map(({ value }) => value)).toEqual(corpus);
  expect(verdicts.filter(({ database }) => database).length).toBeGreaterThan(5);
  expect(verdicts.filter(({ database }) => !database).length).toBeGreaterThan(5);
  return verdicts.filter((verdict) => verdict.contract !== verdict.database);
}

describe('the contract predicates and the generated CHECKs', () => {
  it('give the same verdict on every slug', async () => {
    expect(
      await disagreements(caseStudies, 'slug', 'case_studies_slug_check', slugs, isSlug),
    ).toEqual([]);
  });

  it('give the same verdict on every hostname', async () => {
    expect(
      await disagreements(domains, 'hostname', 'domains_hostname_check', hostnames, isHostname),
    ).toEqual([]);
  });

  it.each([
    ['projects.url', 'projects_url_check'],
    ['projects.repo_url', 'projects_repo_url_check'],
  ] as const)('give the same verdict on every %s value', async (field, name) => {
    const column = field.slice(field.indexOf('.') + 1);
    expect(await disagreements(projects, column, name, urls, isHttpsUrl)).toEqual([]);
  });

  it('give the same verdict on every profile link URL', async () => {
    expect(await linkDisagreements(urls)).toEqual([]);
  });

  it.each([
    ['profiles.bio_md', profiles, 'bio_md'],
    ['experiences.summary_md', experiences, 'summary_md'],
    ['case_studies.body_md', caseStudies, 'body_md'],
  ] as const)('give the same fence verdict on every %s value', async (_column, table, column) => {
    const name = `${getTableName(table)}_${column}_fences_check`;
    expect(await disagreements(table, column, name, markdown, withinFenceLimit)).toEqual([]);
  });
});

describe('the contract predicates and the generated CHECKs on a seeded sweep', () => {
  it.each(sweeps)('give the same verdict on every generated $what', async (sweep) => {
    const corpus = [...new Set(sweep.corpus)];
    expect(corpus.length).toBeGreaterThan(1_000);
    expect(
      await disagreements(sweep.table, sweep.column, sweep.name, corpus, sweep.contract),
    ).toEqual([]);
  });

  it('give the same verdict on every generated profile link URL', async () => {
    const corpus = [...new Set(generated(5, urlPieces, 8))];
    expect(corpus.length).toBeGreaterThan(1_000);
    expect(await linkDisagreements(corpus)).toEqual([]);
  });
});

describe('the content migrations', () => {
  it('install every CHECK exactly as the schema generates it', async () => {
    const rollback = new Error('rollback');
    const compared: { name: string; installed: string | null; generated: string }[] = [];
    await drizzle(owner)
      .transaction(async (tx) => {
        for (const table of contentTables) {
          const name = sql.identifier(getTableName(table));
          await tx.execute(sql`create temporary table ${name} (like public.${name})`);
          for (const check of getTableConfig(table).checks) {
            await tx.execute(
              sql`alter table pg_temp.${name} add constraint ${sql.identifier(check.name)} check (${check.value})`,
            );
          }
          const { rows } = await tx.execute<(typeof compared)[number]>(
            sql`select generated.conname as name, pg_get_constraintdef(installed.oid) as installed, pg_get_constraintdef(generated.oid) as generated from pg_constraint generated left join pg_constraint installed on installed.conname = generated.conname and installed.conrelid = ${`public.${getTableName(table)}`}::regclass where generated.conrelid = ${`pg_temp.${getTableName(table)}`}::regclass and generated.contype = 'c'`,
          );
          compared.push(...rows);
        }
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    expect(compared.map(({ name }) => name).sort()).toEqual(
      contentTables
        .flatMap((table) => getTableConfig(table).checks.map((check) => check.name))
        .sort(),
    );
    expect(compared.filter((row) => row.installed !== row.generated)).toEqual([]);
  });
});
