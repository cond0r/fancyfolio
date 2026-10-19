import { sql } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';
import { tenantDatabase } from '../src/with-tenant.ts';
import { type Cut, cuttingProxy, watchUncaught } from './cutting-proxy.ts';

const { mode, appUrl } = inject('db');

describe.runIf(mode === 'local')('a connection lost inside withTenant', () => {
  let proxy: Awaited<ReturnType<typeof cuttingProxy>>;
  let uncaught: ReturnType<typeof watchUncaught>;

  beforeAll(async () => {
    proxy = await cuttingProxy(appUrl);
  });

  beforeEach(() => {
    uncaught = watchUncaught();
  });

  afterEach(() => uncaught.stop());

  afterAll(() => proxy.close());

  it.each<Cut>(['socket killed', 'FATAL 57P01 then close'])(
    'rejects only that call when the %s, and the next call succeeds',
    async (cut) => {
      const db = tenantDatabase(proxy.url);
      const marker = `lost-connection-${cut.replace(/\W/g, '-')}`;
      proxy.cutOn(marker, cut);
      await expect(
        db.withTenant({ kind: 'job' }, (tx) => tx.execute(sql`select ${marker}::text`)),
      ).rejects.toBeInstanceOf(Error);
      const [row] = await db.withTenant({ kind: 'job' }, (tx) =>
        tx.execute<{ alive: number }>(sql`select 1 as alive`),
      );
      expect(row).toEqual({ alive: 1 });
      expect(uncaught.seen).toEqual([]);
    },
  );

  it('settles a statement fn sends after the loss, instead of leaving it pending', async () => {
    const db = tenantDatabase(proxy.url);
    proxy.cutOn('lost-connection-late', 'socket killed');
    let late: unknown;
    await expect(
      db.withTenant({ kind: 'job' }, async (tx) => {
        await tx.execute(sql`select ${'lost-connection-late'}::text`).catch(() => {});
        late = await tx.execute(sql`select 2`).catch((error: unknown) => error);
      }),
    ).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(late).toMatchObject({ cause: { code: 'CONNECTION_CLOSED' } }));
    expect(uncaught.seen).toEqual([]);
  });
});
