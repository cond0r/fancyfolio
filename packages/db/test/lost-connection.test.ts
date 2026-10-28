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
import {
  createTenant,
  createUser,
  deleteUsers,
  outcomeOf,
  requireWritable,
  rows,
} from './fixtures.ts';

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
    owner.tenantId = await createTenant({ pool: app }, owner.userId, 'tomas');
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
    db.withTenant({ kind: 'job' }, (tx) => rows(tx)(sql`select 1 as alive`));

  it.each<[Cut, object]>([
    ['socket killed', {}],
    ['FATAL 57P01 then close', { cause: { code: '57P01' } }],
    ['reply then reset', {}],
  ])(
    'rejects only that call when the %s, and the next calls on that pool succeed',
    async (cut, cause) => {
      const db = tenantDatabase(proxy.url, { max: 1 });
      const marker = `lost-connection-${cut.replace(/\W/g, '-')}`;
      proxy.cutOn(marker, cut);
      const thrown = await outcomeOf(() =>
        db.withTenant({ kind: 'job' }, (tx) => tx.execute(sql`select ${marker}::text`)),
      );
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toMatchObject(cause);
      const next = await Promise.all(Array.from({ length: 10 }, () => alive(db)));
      expect(next).toEqual(Array(10).fill([{ alive: 1 }]));
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
        await outcomeOf(() =>
          tx.execute(sql`select current_setting('app.tenant_id', true) as tenant`),
        ),
        await outcomeOf(() =>
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

  it('rejects, instead of waiting on, a call whose connect gets no answer', async () => {
    proxy.blackhole();
    const db = tenantDatabase(proxy.url);
    const call = db.withTenant({ kind: 'job' }, (tx) => tx.execute(sql`select 1`));
    expect(await settlesWithin(6000, call)).toBe('rejected');
    expect(uncaught.seen).toEqual([]);
  });

  it('rejects, instead of waiting on, a call whose statement gets no answer', async () => {
    const db = tenantDatabase(proxy.url);
    await db.withTenant({ kind: 'job' }, (tx) => tx.execute(sql`select 1`));
    const marker = 'lost-connection-half-open';
    proxy.cutOn(marker, 'stall');
    const call = db.withTenant({ kind: 'job' }, (tx) => tx.execute(sql`select ${marker}::text`));
    expect(await settlesWithin(8000, call)).toBe('rejected');
    expect(uncaught.seen).toEqual([]);
  });
});
