import { format } from 'node:util';
import { sql } from 'drizzle-orm';
import { type TenantDatabase, tenantDatabase } from '../src/with-tenant.ts';

export function stringsInsideWithTenant(db: TenantDatabase, key: string, sort: string) {
  return db.withTenant({ userId: key }, async (tx) => {
    const query = `select id from tenants where subdomain = '${key}'`;
    await tx.execute(sql`select id from tenants where subdomain = ${key}`);
    // @ts-expect-error
    await tx.execute(query);
    // @ts-expect-error
    await tx.execute(String.raw`select id from tenants where subdomain = '${key}'`);
    // @ts-expect-error
    await tx.execute(`select id from tenants where subdomain = '${key}'`.trim());
    // @ts-expect-error
    await tx.execute(`select id from tenants where subdomain = '${key}'` as string);
    // @ts-expect-error
    await tx.execute(sort ? `select id from tenants order by ${sort}` : 'select 1');
    // @ts-expect-error
    await tx.execute(['select id from tenants where subdomain =', `'${key}'`].join(' '));
    // @ts-expect-error
    await tx.execute('select id from tenants'.concat(` where subdomain = '${key}'`));
    // @ts-expect-error
    await tx.execute(format("select id from tenants where subdomain = '%s'", key));
    // @ts-expect-error
    await tx.execute(String(query));
    const run = tx.execute.bind(tx);
    // @ts-expect-error
    await run(query);
    const { execute } = tx;
    // @ts-expect-error
    await execute.call(tx, query);
    // @ts-expect-error
    await tx.transaction((nested) => nested.execute(query));
    // @ts-expect-error
    await tx._.session.transaction((nested) => nested.execute(query));
  });
}

export async function stringsOnTheTenantDatabase(url: string, key: string) {
  const db = tenantDatabase(url);
  const query = `select id from tenants where subdomain = '${key}'`;
  await db.withTenant({ userId: key }, (tx) => tx.execute(sql`select ${key}`));
  // @ts-expect-error
  await db.execute(query);
  // @ts-expect-error
  await db.$client.unsafe(query);
  // @ts-expect-error
  await db.transaction(query);
}
