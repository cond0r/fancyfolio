import { eq, sql } from 'drizzle-orm';
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
import { connect } from '../src/client.ts';
import { projects } from '../src/schema/content.ts';
import { tenantDatabase } from '../src/with-tenant.ts';
import { type Cut, cuttingProxy, settlesWithin, watchUncaught } from './cutting-proxy.ts';
import { createTenant, createUser, deleteUsers, requireWritable } from './fixtures.ts';

const { mode, appUrl, authUrl } = inject('db');

describe.runIf(mode === 'local')('a connection lost inside withTenant', () => {
  let proxy: Awaited<ReturnType<typeof cuttingProxy>>;
  let uncaught: ReturnType<typeof watchUncaught>;
  const app = connect(appUrl);
  const auth = connect(authUrl);
  const owner = { userId: '', tenantId: '' };

  beforeAll(async () => {
    requireWritable();
    proxy = await cuttingProxy(appUrl);
    owner.userId = await createUser(auth, 'Tomas Lind', 'tomas@example.test');
    owner.tenantId = await createTenant(app, owner.userId, 'tomas');
  });

  beforeEach(() => {
    uncaught = watchUncaught();
  });

  afterEach(() => uncaught.stop());

  afterAll(async () => {
    await deleteUsers(auth, [owner.userId]);
    await Promise.all([proxy.close(), app.end(), auth.end()]);
  });

  const alive = (db: ReturnType<typeof tenantDatabase>) =>
    db.withTenant({ kind: 'job' }, (tx) => tx.execute(sql`select 1`));

  const outcome = async (run: () => PromiseLike<unknown>): Promise<unknown> => {
    try {
      return await run();
    } catch (error) {
      return error;
    }
  };

  it('opens at most the pool size it is given', async () => {
    const db = tenantDatabase(appUrl, { max: 1 });
    const pids = await Promise.all(
      Array.from({ length: 3 }, () =>
        db.withTenant({ kind: 'job' }, async (tx) => {
          const {
            rows: [row],
          } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
          return row.pid;
        }),
      ),
    );
    expect(new Set(pids).size).toBe(1);
  });

  it.each<Cut>(['socket killed', 'FATAL 57P01 then close'])(
    'rejects only that call when the %s, and the next call succeeds',
    async (cut) => {
      const db = tenantDatabase(proxy.url);
      const marker = `lost-connection-${cut.replace(/\W/g, '-')}`;
      proxy.cutOn(marker, cut);
      await expect(
        db.withTenant({ kind: 'job' }, (tx) => tx.execute(sql`select ${marker}::text`)),
      ).rejects.toBeInstanceOf(Error);
      const {
        rows: [row],
      } = await db.withTenant({ kind: 'job' }, (tx) =>
        tx.execute<{ alive: number }>(sql`select 1 as alive`),
      );
      expect(row).toEqual({ alive: 1 });
      expect(uncaught.seen).toEqual([]);
    },
  );

  it('runs no statement fn sends after the loss, neither alone nor in the next caller', async () => {
    const db = tenantDatabase(proxy.url, { max: 1 });
    const context = { kind: 'user', userId: owner.userId } as const;
    const written = Promise.withResolvers<void>();
    const lateSent = Promise.withResolvers<void>();
    const late: unknown[] = [];
    let next: Promise<void> | undefined;
    const first = db.withTenant(context, async (tx) => {
      await tx.execute(sql`select 1`);
      proxy.killAll();
      next = db.withTenant(context, async (other, tenantId) => {
        await other.insert(projects).values({ tenantId: tenantId ?? '', name: 'Kept' });
        written.resolve();
        await lateSent.promise;
      });
      await Promise.race([written.promise, Promise.allSettled([next])]);
      late.push(
        await outcome(() =>
          tx.execute(sql`select current_setting('app.tenant_id', true) as tenant`),
        ),
        await outcome(() =>
          tx.update(projects).set({ name: 'Overwritten' }).where(eq(projects.name, 'Kept')),
        ),
      );
      lateSent.resolve();
    });
    await expect(first).rejects.toBeInstanceOf(Error);
    await next;
    expect(late).toEqual([expect.any(Error), expect.any(Error)]);
    const names = await db.withTenant(context, (tx) =>
      tx.select({ name: projects.name }).from(projects),
    );
    expect(names).toEqual([{ name: 'Kept' }]);
    expect(uncaught.seen).toEqual([]);
  });

  it('serves 10 concurrent calls on a one-connection pool after a FATAL 57P01', async () => {
    const db = tenantDatabase(proxy.url, { max: 1 });
    await alive(db);
    const marker = 'lost-connection-fatal-burst';
    proxy.cutOn(marker, 'FATAL 57P01 then close');
    let cut: unknown;
    await expect(
      db.withTenant({ kind: 'job' }, (tx) =>
        tx.execute(sql`select ${marker}::text`).catch((error: unknown) => {
          cut = error;
          throw error;
        }),
      ),
    ).rejects.toBeInstanceOf(Error);
    const burst = await Promise.allSettled(Array.from({ length: 10 }, () => alive(db)));
    expect({ cut, burst: burst.map(({ status }) => status) }).toMatchObject({
      cut: { cause: { code: '57P01' } },
      burst: Array(10).fill('fulfilled'),
    });
    expect(uncaught.seen).toEqual([]);
  });

  it('answers every call within 8 s on a one-connection pool reset right after replies', async () => {
    const db = tenantDatabase(proxy.url, { max: 1 });
    await alive(db);
    for (const round of [1, 2, 3]) {
      const marker = `lost-connection-reset-${round}`;
      proxy.cutOn(marker, 'reply then reset');
      const calls = [
        db.withTenant({ kind: 'job' }, async (tx) => {
          await tx.execute(sql`select ${marker}::text`);
          await tx.execute(sql`select 2`);
        }),
        ...Array.from({ length: 11 }, () => alive(db)),
      ];
      const outcomes = await Promise.all(calls.map((call) => settlesWithin(8000, call)));
      expect(outcomes, `round ${round}`).not.toContain('pending');
    }
    expect(uncaught.seen).toEqual([]);
  }, 60_000);

  it('serves the next call after a statement of 1 KiB or more sent after a kill', async () => {
    const db = tenantDatabase(proxy.url, { max: 1 });
    const marker = 'lost-connection-big-late';
    proxy.cutOn(marker, 'socket killed');
    await expect(
      db.withTenant({ kind: 'job' }, async (tx) => {
        await tx.execute(sql`select ${marker}::text`).catch(() => undefined);
        await tx.execute(sql`select ${'x'.repeat(2048)}::text`);
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(await settlesWithin(8000, alive(db))).toBe('fulfilled');
    expect(uncaught.seen).toEqual([]);
  });

  it('logs one generic line, not an uncaught error, when an idle connection breaks', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = tenantDatabase(proxy.url, { max: 1 });
      await alive(db);
      proxy.killAll();
      await vi.waitFor(() => expect(logged).toHaveBeenCalledWith('Database connection error'));
      expect(await settlesWithin(8000, alive(db))).toBe('fulfilled');
      expect(uncaught.seen).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  it('settles a statement fn sends after the loss, instead of leaving it pending', async () => {
    const db = tenantDatabase(proxy.url);
    proxy.cutOn('lost-connection-late', 'socket killed');
    let late: unknown;
    await expect(
      db.withTenant({ kind: 'job' }, async (tx) => {
        await tx.execute(sql`select ${'lost-connection-late'}::text`).catch(() => {});
        late = await outcome(() => tx.execute(sql`select 2`));
      }),
    ).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(late).toBeInstanceOf(Error));
    expect(uncaught.seen).toEqual([]);
  });
});

describe.runIf(mode === 'local')('a database that stops answering', () => {
  let proxy: Awaited<ReturnType<typeof cuttingProxy>>;
  let uncaught: ReturnType<typeof watchUncaught>;

  beforeEach(async () => {
    proxy = await cuttingProxy(appUrl);
    uncaught = watchUncaught();
  });

  afterEach(async () => {
    uncaught.stop();
    await proxy.close();
  });

  it('rejects a call whose connect gets no answer within 6 s', async () => {
    proxy.blackhole();
    const db = tenantDatabase(proxy.url);
    const call = db.withTenant({ kind: 'job' }, (tx) => tx.execute(sql`select 1`));
    expect(await settlesWithin(6000, call)).toBe('rejected');
    expect(uncaught.seen).toEqual([]);
  });

  it('rejects a call whose statement gets no answer within 8 s', async () => {
    const db = tenantDatabase(proxy.url);
    await db.withTenant({ kind: 'job' }, (tx) => tx.execute(sql`select 1`));
    const marker = 'lost-connection-half-open';
    proxy.cutOn(marker, 'stall');
    const call = db.withTenant({ kind: 'job' }, (tx) => tx.execute(sql`select ${marker}::text`));
    expect(await settlesWithin(8000, call)).toBe('rejected');
    expect(uncaught.seen).toEqual([]);
  });
});
