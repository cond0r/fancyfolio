import { randomBytes, randomUUID } from 'node:crypto';
import { eq, type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';
import { domains } from '../src/schema/content.ts';
import { tenants } from '../src/schema/tenants.ts';
import {
  type TenantContext,
  type TenantPool,
  type TenantTransaction,
  withTenant,
} from '../src/with-tenant.ts';
import { createTenant, createUser, deleteUsers, requireWritable, rows } from './fixtures.ts';

const { appUrl, authUrl } = inject('db');
const app = connect(appUrl);
const auth = connect(authUrl);
const db: TenantPool = { pool: app };
const noContext = drizzle(app);
const notJob = { cause: { code: '42501' } };
const inFuture = { cause: { code: '23514', constraint: 'domains_claim_time_check' } };
const taken = { cause: { code: '23505', constraint: 'domains_verified_hostname_unique' } };

type Owner = { userId: string; tenantId: string; subdomain: string; hostname: string };
const live: Owner = {
  userId: '',
  tenantId: '',
  subdomain: 'amara-domains',
  hostname: 'amara.example',
};
const pending: Owner = {
  userId: '',
  tenantId: '',
  subdomain: 'kenji-domains',
  hostname: 'kenji.example',
};
const lapsed: Owner = {
  userId: '',
  tenantId: '',
  subdomain: 'priya-domains',
  hostname: 'priya.example',
};
const owners = [live, pending, lapsed];

type Row = { hostname: string; verified: string | null; checked: string | null };

function asOwner<T>(owner: Owner, fn: (tx: TenantTransaction) => Promise<T>) {
  return withTenant(db, { kind: 'user', userId: owner.userId }, fn);
}

function setDomain(owner: Owner, change: SQL) {
  return asOwner(owner, (tx) =>
    tx.execute(sql`update domains set ${change} where tenant_id = ${owner.tenantId}`),
  );
}

async function rowOf(owner: Owner): Promise<Row> {
  const [row] = await asOwner(owner, (tx) =>
    rows<Row>(tx)(
      sql`select hostname, verified_at::text as verified, checked_at::text as checked from domains`,
    ),
  );
  return row;
}

async function resolve(key: string | null): Promise<string | null> {
  const [row] = await withTenant(db, { kind: 'job' }, (tx) =>
    rows<{ id: string | null }>(tx)(sql`select app.resolve_site(${key}::text) as id`),
  );
  return row.id;
}

const token = (seed: string) => seed.padEnd(43, '_');
const tokenOf = (owner: Owner) => token(owner.subdomain);

function recordTxt(host: string | null, token: string | null, seen: boolean | null) {
  return withTenant(db, { kind: 'job' }, (tx) =>
    tx.execute(sql`select app.record_txt(${host}::text, ${token}::text, ${seen}::boolean)`),
  );
}

function toRecheck(max: number | null) {
  return withTenant(db, { kind: 'job' }, (tx) =>
    rows<{ hostname: string; challenge_token: string }>(tx)(
      sql`select hostname, challenge_token from app.domains_to_recheck(${max}::integer)`,
    ),
  );
}

async function reset() {
  for (const owner of owners) {
    await setDomain(owner, sql`hostname = ${owner.hostname}, challenge_token = ${tokenOf(owner)}`);
  }
  await setDomain(pending, sql`verified_at = null, checked_at = null`);
  await setDomain(live, sql`verified_at = now(), checked_at = now()`);
  await setDomain(
    lapsed,
    sql`verified_at = now() - interval '10 days', checked_at = now() - interval '72 hours'`,
  );
}

beforeAll(async () => {
  requireWritable();
  for (const owner of owners) {
    owner.userId = await createUser(auth, owner.subdomain, `${owner.subdomain}@example.test`);
    owner.tenantId = await createTenant(db, owner.userId, owner.subdomain);
    await asOwner(owner, (tx) =>
      tx.insert(domains).values({
        tenantId: owner.tenantId,
        hostname: owner.hostname,
        challengeToken: tokenOf(owner),
      }),
    );
  }
  await reset();
});

afterAll(async () => {
  await deleteUsers(
    auth,
    owners.map((owner) => owner.userId),
  );
  await Promise.all([app.end(), auth.end()]);
});

describe('app.resolve_site', () => {
  it('resolves an exact subdomain and an exact live hostname to their tenant', async () => {
    await reset();
    expect(await resolve(live.subdomain)).toBe(live.tenantId);
    expect(await resolve(pending.subdomain)).toBe(pending.tenantId);
    expect(await resolve(live.hostname)).toBe(live.tenantId);
  });

  it.each([
    ['an unverified hostname', () => pending.hostname],
    ['a lapsed hostname that is still verified', () => lapsed.hostname],
    ['an unknown hostname', () => 'nobody.example'],
    ['an unknown subdomain', () => 'nobody'],
    ['an upper-case subdomain', () => live.subdomain.toUpperCase()],
    ['an upper-case hostname', () => live.hostname.toUpperCase()],
    ['a partial subdomain', () => live.subdomain.slice(0, -1)],
    ['a partial hostname', () => live.hostname.slice(1)],
    ['a hostname with a trailing dot', () => `${live.hostname}.`],
    ['a LIKE wildcard hostname', () => '%.example'],
    ['a LIKE wildcard subdomain', () => 'amara%'],
    ['a hostile key', () => "amara-domains' or '1'='1"],
    ['the empty key', () => ''],
    ['no key', () => null],
  ])('resolves %s to null', async (_case, key) => {
    await reset();
    expect(await resolve(key())).toBeNull();
  });

  it('never resolves or shows an unverified hostname, even one checked a minute ago', async () => {
    await reset();
    await setDomain(pending, sql`checked_at = now() - interval '1 minute'`);
    expect(await resolve(pending.hostname)).toBeNull();
    expect(
      await withTenant(db, { kind: 'site', site: pending.subdomain }, (tx) =>
        tx.select({ hostname: domains.hostname }).from(domains),
      ),
    ).toEqual([]);
    await reset();
  });

  it('stops resolving a hostname at checked_at + 72 h with no write', async () => {
    await setDomain(live, sql`checked_at = now() - interval '71 hours 59 minutes'`);
    expect(await resolve(live.hostname)).toBe(live.tenantId);
    await setDomain(live, sql`checked_at = now() - interval '72 hours'`);
    expect(await resolve(live.hostname)).toBeNull();
    expect((await rowOf(live)).verified).not.toBeNull();
    await reset();
  });

  it('finds a hostname through the verified-hostname index, never by scanning domains', async () => {
    await reset();
    const scansOf = async (tx: TenantTransaction) => {
      const counts = await rows<{ via: string; scans: number }>(tx)(sql`
        select c.relname as via, pg_stat_get_xact_numscans(c.oid)::int as scans from pg_class c
        where c.oid = 'public.domains'::regclass
          or c.oid in (select indexrelid from pg_index where indrelid = 'public.domains'::regclass)
      `);
      return new Map(counts.map(({ via, scans }) => [via, scans]));
    };
    const outcome = await withTenant(db, { kind: 'job' }, async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local jit = off`);
      const before = await scansOf(tx);
      const [row] = await rows<{ id: string | null }>(tx)(
        sql`select app.resolve_site(${live.hostname}::text) as id`,
      );
      const after = await scansOf(tx);
      const scanned = [...after].filter(([via, scans]) => scans !== before.get(via));
      return { id: row.id, scanned: scanned.map(([via]) => via) };
    });
    expect(outcome).toEqual({ id: live.tenantId, scanned: ['domains_verified_hostname_unique'] });
  });
});

describe('app.domains_to_recheck', () => {
  it('lists verified hostnames with their tokens, oldest check first', async () => {
    await reset();
    expect(await toRecheck(500)).toEqual([
      { hostname: lapsed.hostname, challenge_token: tokenOf(lapsed) },
      { hostname: live.hostname, challenge_token: tokenOf(live) },
    ]);
    expect(await toRecheck(1)).toEqual([
      { hostname: lapsed.hostname, challenge_token: tokenOf(lapsed) },
    ]);
    expect(await toRecheck(0)).toEqual([]);
    expect(await toRecheck(-1)).toEqual([]);
  });

  describe('with more than 500 verified domains', () => {
    const crowd: string[] = [];

    beforeAll(async () => {
      const users = await rows<{ id: string }>(drizzle(auth))(sql`
        insert into users (name, email)
        select 'Crowd ' || n, 'crowd-' || n || '@example.test' from generate_series(1, 501) as n
        returning id
      `);
      crowd.push(...users.map((user) => user.id));
      for (const [index, userId] of crowd.entries()) {
        await withTenant(db, { kind: 'user', userId, onboarding: true }, async (tx, tenantId) => {
          const id = tenantId ?? '';
          await tx.insert(tenants).values({ id, subdomain: `crowd-${index}`, ownerId: userId });
          await tx.insert(domains).values({
            tenantId: id,
            hostname: `crowd-${index}.example`,
            challengeToken: token(`t${index}`),
            verifiedAt: sql`now()`,
            checkedAt: sql`now()`,
          });
        });
      }
    });

    afterAll(() => deleteUsers(auth, crowd));

    it.each([600, 2_147_483_647, null])(
      'returns at most 500 rows when asked for %j',
      async (max) => {
        expect(await toRecheck(max)).toHaveLength(500);
      },
    );
  });
});

describe('app.record_txt', () => {
  it('refreshes checked_at on an exact token match and keeps the claim', async () => {
    await reset();
    await setDomain(live, sql`checked_at = now() - interval '2 days'`);
    const before = await rowOf(live);
    await recordTxt(live.hostname, tokenOf(live), true);
    const after = await rowOf(live);
    expect(after.verified).toBe(before.verified);
    expect(after.checked !== null && after.checked > (before.checked ?? '')).toBe(true);
  });

  it('brings a lapsed but still verified hostname back on a match', async () => {
    await reset();
    expect(await resolve(lapsed.hostname)).toBeNull();
    await recordTxt(lapsed.hostname, tokenOf(lapsed), true);
    expect(await resolve(lapsed.hostname)).toBe(lapsed.tenantId);
    await reset();
  });

  it("never refreshes a later claim of the hostname with an earlier claim's result", async () => {
    await reset();
    await setDomain(live, sql`checked_at = now() - interval '73 hours'`);
    await recordTxt(live.hostname, tokenOf(live), false);
    await setDomain(pending, sql`hostname = ${live.hostname}`);
    await setDomain(pending, sql`verified_at = now(), checked_at = now() - interval '71 hours'`);
    const before = await rowOf(pending);
    await recordTxt(live.hostname, tokenOf(live), true);
    expect(await rowOf(pending)).toEqual(before);
    await recordTxt(live.hostname, tokenOf(pending), true);
    expect(await rowOf(pending)).not.toEqual(before);
    await reset();
  });

  it('keeps a hostname unseen for less than 72 h verified', async () => {
    await reset();
    await setDomain(live, sql`checked_at = now() - interval '71 hours'`);
    const before = await rowOf(live);
    await recordTxt(live.hostname, tokenOf(live), false);
    expect(await rowOf(live)).toEqual(before);
  });

  it('frees a hostname unseen for over 72 h, and a second run changes nothing more', async () => {
    await reset();
    await setDomain(lapsed, sql`checked_at = now() - interval '72 hours 1 second'`);
    const before = await rowOf(lapsed);
    await recordTxt(lapsed.hostname, tokenOf(lapsed), false);
    const freed = await rowOf(lapsed);
    expect(freed).toEqual({ ...before, verified: null });
    await recordTxt(lapsed.hostname, tokenOf(lapsed), false);
    await recordTxt(lapsed.hostname, tokenOf(lapsed), true);
    expect(await rowOf(lapsed)).toEqual(freed);
    expect(await toRecheck(500)).toEqual([
      { hostname: live.hostname, challenge_token: tokenOf(live) },
    ]);
  });

  it.each([
    ['an unverified hostname seen', () => [pending.hostname, tokenOf(pending), true] as const],
    ['an upper-case hostname', () => [live.hostname.toUpperCase(), tokenOf(live), true] as const],
    ['a LIKE wildcard hostname', () => ['%.example', tokenOf(lapsed), false] as const],
    ['a stale token seen', () => [live.hostname, tokenOf(pending), true] as const],
    ['a stale token unseen', () => [lapsed.hostname, tokenOf(pending), false] as const],
    ['a LIKE wildcard token', () => [live.hostname, `${live.subdomain}%`, true] as const],
    ['a null hostname', () => [null, tokenOf(live), true] as const],
    ['a null token', () => [live.hostname, null, true] as const],
    ['a null outcome', () => [lapsed.hostname, tokenOf(lapsed), null] as const],
  ])('changes nothing for %s', async (_case, args) => {
    await reset();
    await setDomain(lapsed, sql`checked_at = now() - interval '5 days'`);
    const before = await Promise.all(owners.map(rowOf));
    const [host, token, seen] = args();
    await recordTxt(host, token, seen);
    expect(await Promise.all(owners.map(rowOf))).toEqual(before);
  });
});

describe('the re-check functions', () => {
  it.each([
    ['the owner of the hostname', (): TenantContext => ({ kind: 'user', userId: live.userId })],
    ["another tenant's owner", (): TenantContext => ({ kind: 'user', userId: pending.userId })],
    ['the public site context', (): TenantContext => ({ kind: 'site', site: live.subdomain })],
    ['an unknown site', (): TenantContext => ({ kind: 'site', site: 'nobody.example' })],
  ])('refuse %s, which neither lists nor refreshes any domain', async (_case, context) => {
    await reset();
    await setDomain(live, sql`checked_at = now() - interval '2 days'`);
    const before = await Promise.all(owners.map(rowOf));
    await expect(
      withTenant(db, context(), (tx) =>
        tx.execute(sql`select hostname, challenge_token from app.domains_to_recheck(500)`),
      ),
    ).rejects.toMatchObject(notJob);
    await expect(
      withTenant(db, context(), (tx) =>
        tx.execute(
          sql`select app.record_txt(${live.hostname}::text, ${tokenOf(live)}::text, true)`,
        ),
      ),
    ).rejects.toMatchObject(notJob);
    expect(await Promise.all(owners.map(rowOf))).toEqual(before);
  });

  it('refuse a session without any context', async () => {
    await expect(
      noContext.execute(sql`select hostname from app.domains_to_recheck(500)`),
    ).rejects.toMatchObject(notJob);
    await expect(
      noContext.execute(
        sql`select app.record_txt(${live.hostname}::text, ${tokenOf(live)}::text, true)`,
      ),
    ).rejects.toMatchObject(notJob);
  });
});

describe('the claim times', () => {
  it.each([
    ['checked_at at infinity', sql`checked_at = 'infinity'`],
    ['checked_at a second ahead', sql`checked_at = now() + interval '1 second'`],
    ['verified_at tomorrow', sql`verified_at = now() + interval '1 day'`],
    ['both far ahead', sql`verified_at = '9999-01-01', checked_at = '9999-01-01'`],
  ])('refuse %s from the owner', async (_case, change) => {
    await reset();
    const before = await rowOf(live);
    await expect(setDomain(live, change)).rejects.toMatchObject(inFuture);
    expect(await rowOf(live)).toEqual(before);
  });

  it('refuse a claim in the future on insert', async () => {
    await reset();
    await expect(
      asOwner(pending, async (tx) => {
        await tx.execute(sql`delete from domains`);
        await tx.insert(domains).values({
          tenantId: pending.tenantId,
          hostname: 'later.example',
          challengeToken: token('later'),
          verifiedAt: sql`now()`,
          checkedAt: sql`'infinity'`,
        });
      }),
    ).rejects.toMatchObject(inFuture);
    expect((await rowOf(pending)).hostname).toBe(pending.hostname);
  });

  it('take the time of the check the owner records, the path a TXT proof takes', async () => {
    await reset();
    await setDomain(pending, sql`verified_at = coalesce(verified_at, now()), checked_at = now()`);
    expect(await resolve(pending.hostname)).toBe(pending.tenantId);
    await reset();
  });

  it.each([
    ['hostname', () => sql`hostname = 'renamed.example'`],
    ['challenge token', () => sql`challenge_token = ${token('renamed')}`],
    [
      'hostname while restamping the claim',
      () => sql`hostname = 'renamed.example', verified_at = now(), checked_at = now()`,
    ],
  ])('are dropped when the owner changes the %s', async (_case, change) => {
    await reset();
    await setDomain(live, change());
    expect(await rowOf(live)).toMatchObject({ verified: null, checked: null });
    expect(await resolve('renamed.example')).toBeNull();
    expect(await resolve(live.hostname)).toBeNull();
    expect(await toRecheck(500)).toEqual([
      { hostname: lapsed.hostname, challenge_token: tokenOf(lapsed) },
    ]);
    await reset();
  });
});

describe('the domains table', () => {
  it('lets a tenant hold one domain row', async () => {
    await expect(
      asOwner(live, (tx) =>
        tx.insert(domains).values({
          tenantId: live.tenantId,
          hostname: 'second.example',
          challengeToken: token('x'),
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'domains_tenant_id_unique' },
    });
  });

  it('lets a second tenant add a verified hostname unverified, never verify it while held, and claim it once freed', async () => {
    await reset();
    await setDomain(pending, sql`hostname = ${live.hostname}`);
    expect((await rowOf(pending)).hostname).toBe(live.hostname);
    await expect(
      setDomain(pending, sql`verified_at = now(), checked_at = now()`),
    ).rejects.toMatchObject(taken);
    await setDomain(live, sql`checked_at = now() - interval '73 hours'`);
    await expect(
      setDomain(pending, sql`verified_at = now(), checked_at = now()`),
    ).rejects.toMatchObject(taken);
    await recordTxt(live.hostname, tokenOf(live), false);
    await setDomain(pending, sql`verified_at = now(), checked_at = now()`);
    expect(await resolve(live.hostname)).toBe(pending.tenantId);
    await reset();
  });

  it.each([
    ['upper case', 'Amara.example'],
    ['a single label', 'localhost'],
    ['an IPv4 literal', '127.0.0.1'],
    ['a port', 'amara.example:443'],
    ['a trailing newline', 'amara.example\n'],
    [
      '254 characters',
      `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(59)}.ab`,
    ],
  ])('refuses a hostname with %s', async (_case, hostname) => {
    await expect(setDomain(pending, sql`hostname = ${hostname}`)).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'domains_hostname_check' },
    });
  });

  it.each([
    ['nothing in it', ''],
    ['one character', 'a'],
    ['42 characters', 'a'.repeat(42)],
    ['65 characters', 'a'.repeat(65)],
    ['base64 padding', `${'a'.repeat(43)}=`],
    ['a plus', `${'a'.repeat(42)}+`],
    ['a slash', `${'a'.repeat(42)}/`],
    ['a space', `${'a'.repeat(21)} ${'a'.repeat(21)}`],
    ['a trailing newline', `${'a'.repeat(43)}\n`],
    ['a non-ASCII letter', `${'a'.repeat(42)}é`],
    ['the TXT record prefix', `fancyfolio-verify=${'a'.repeat(43)}`],
    ['a quote and a comment', `${'a'.repeat(43)}'; drop table domains; --`],
  ])('refuses a challenge token with %s', async (_case, value) => {
    await expect(setDomain(pending, sql`challenge_token = ${value}`)).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'domains_challenge_token_check' },
    });
  });

  it('keeps a challenge token of 32 random bytes in base64url, and one of 64 characters', async () => {
    for (const value of [randomBytes(32).toString('base64url'), '-_'.repeat(32)]) {
      await setDomain(pending, sql`challenge_token = ${value}`);
      const [row] = await asOwner(pending, (tx) =>
        rows<{ token: string }>(tx)(sql`select challenge_token as token from domains`),
      );
      expect(row.token).toBe(value);
    }
    await reset();
  });

  it('refuses a verified row without a check time', async () => {
    await expect(
      setDomain(pending, sql`verified_at = now(), checked_at = null`),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'domains_checked_when_verified_check' },
    });
  });

  it('shows a context without the owner only a live domain, until checked_at + 72 h', async () => {
    await reset();
    const publicView = (owner: Owner) =>
      withTenant(db, { kind: 'site', site: owner.subdomain }, (tx) =>
        tx.select({ hostname: domains.hostname }).from(domains),
      );
    expect(await publicView(live)).toEqual([{ hostname: live.hostname }]);
    expect(await publicView(pending)).toEqual([]);
    expect(await publicView(lapsed)).toEqual([]);
    await setDomain(live, sql`checked_at = now() - interval '72 hours'`);
    expect(await publicView(live)).toEqual([]);
    expect((await rowOf(live)).hostname).toBe(live.hostname);
    expect((await rowOf(pending)).hostname).toBe(pending.hostname);
    await reset();
  });

  it('lets neither the public context nor the job context write a domain row', async () => {
    await expect(
      withTenant(db, { kind: 'site', site: live.subdomain }, (tx) =>
        tx
          .update(domains)
          .set({ checkedAt: sql`now()` })
          .where(eq(domains.tenantId, live.tenantId)),
      ),
    ).rejects.toMatchObject({ cause: { code: '25006' } });
    const updated = await withTenant(db, { kind: 'job' }, (tx) =>
      tx.update(domains).set({ checkedAt: sql`now()` }).where(eq(domains.tenantId, live.tenantId)),
    );
    expect(updated.rowCount).toBe(0);
    await expect(
      withTenant(db, { kind: 'job' }, (tx) =>
        tx
          .insert(domains)
          .values({ tenantId: randomUUID(), hostname: 'job.example', challengeToken: token('x') }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('the domain row version', () => {
  const versionOf = async (owner: Owner) => {
    const [row] = await asOwner(owner, (tx) =>
      rows<{ version: string }>(tx)(sql`select updated_at::text as version from domains`),
    );
    return row.version;
  };
  const movedSince = async (owner: Owner, version: string) => {
    const [row] = await asOwner(owner, (tx) =>
      rows<{ moved: boolean }>(tx)(
        sql`select updated_at > ${version}::timestamptz and updated_at <= clock_timestamp() as moved from domains`,
      ),
    );
    return row.moved;
  };

  it('moves updated_at on every owner write, whatever value it sets, and on every re-check', async () => {
    await reset();
    const loaded = await versionOf(live);
    await setDomain(live, sql`updated_at = 'infinity'`);
    expect(await movedSince(live, loaded)).toBe(true);
    const written = await versionOf(live);
    await recordTxt(live.hostname, tokenOf(live), true);
    expect(await movedSince(live, written)).toBe(true);
  });

  it('refuses a write that carries a version another write replaced', async () => {
    await reset();
    const loaded = await versionOf(live);
    await setDomain(live, sql`challenge_token = ${token('other-tab')}`);
    const stale = await asOwner(live, (tx) =>
      tx.execute(
        sql`update domains set hostname = 'stale.example' where tenant_id = ${live.tenantId} and updated_at = ${loaded}::timestamptz`,
      ),
    );
    expect(stale.rowCount).toBe(0);
    expect(await rowOf(live)).toMatchObject({ hostname: live.hostname });
    await reset();
  });
});
