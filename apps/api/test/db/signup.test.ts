import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@fancyfolio/contracts';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect } from '../../../../packages/db/src/client.ts';
import { requireWritable, rows } from '../../../../packages/db/test/fixtures.ts';
import type {} from '../../../../packages/db/test/setup.ts';

const { appUrl, authUrl } = inject('db');
const password = 'correct-horse-battery-7';
vi.stubEnv('DATABASE_URL', appUrl);
vi.stubEnv('AUTH_DATABASE_URL', authUrl);
vi.stubEnv(
  'SIGNUP_ALLOWLIST',
  'ines.signup@example.test, Kenji.Signup@Example.test, lena.signup@example.test',
);
const { default: api } = await import('../../src/index.ts');
const { auth, createAuth } = await import('../../src/auth.ts');
const { env } = await import('../../src/env.ts');

const pool = connect(authUrl);
const query = rows(drizzle(pool));
let ip = 0;

type Send = (path: string, init: RequestInit) => Response | Promise<Response>;
const viaApi: Send = (path, init) => api.request(path, init);

function post(
  path: string,
  body: Record<string, string>,
  send = viaApi,
  headers: Record<string, string> = {},
) {
  ip += 1;
  return send(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `192.0.2.${100 + ip}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function signUp(email: string, secret = password, send = viaApi, name = 'Fixture Person') {
  return post('/api/auth/sign-up/email', { name, email, password: secret }, send);
}

const seedScript = fileURLToPath(new URL('../../scripts/seed-owner.ts', import.meta.url));

vi.stubEnv('SEED_EMAIL', 'Owner.Signup@example.test');
vi.stubEnv('SEED_NAME', 'Fixture Owner');

function seedOwner(secret: string) {
  const env = { ...process.env, SEED_PASSWORD: secret };
  return new Promise((resolve) => {
    execFile(process.execPath, [seedScript], { timeout: 20_000, env }, (error, stdout, stderr) => {
      resolve({ status: error?.code ?? 0, output: `${stdout}${stderr}` });
    });
  });
}

function signIn(email: string, secret = password) {
  return post('/api/auth/sign-in/email', { email, password: secret });
}

async function usersNamed(email: string): Promise<number> {
  const [{ users }] = await query(
    sql`select count(*)::int as users from users where email = ${email}`,
  );
  return Number(users);
}

async function expectGenericAnswer(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.getSetCookie()).toEqual([]);
  const body = await res.json();
  expect(body.token).toBeNull();
  expect(Object.keys(body.user).sort()).toEqual([
    'createdAt',
    'email',
    'emailVerified',
    'id',
    'image',
    'name',
    'updatedAt',
  ]);
  return body;
}

beforeAll(() => {
  requireWritable();
});

afterAll(async () => {
  await query(sql`delete from users where email like '%.signup@example.test'`);
  await query(
    sql`delete from rate_limits where key like '192.0.2.%' or key like '%.signup@example.test|%'`,
  );
  await pool.end();
});

describe('invite-only sign-up', () => {
  it('creates an invited user, matched case-insensitively and stored lower case, without signing them in', async () => {
    await expectGenericAnswer(await signUp('ines.signup@example.test'));
    await expectGenericAnswer(await signUp('KENJI.signup@example.TEST'));
    expect(await usersNamed('ines.signup@example.test')).toBe(1);
    expect(await usersNamed('kenji.signup@example.test')).toBe(1);
    const res = await signIn('ines.signup@example.test');
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe('ines.signup@example.test');
  });

  const closed = createAuth([]);
  const viaClosed: Send = (path, init) =>
    closed.handler(new Request(new URL(path, env.BETTER_AUTH_URL), init));
  it.each([
    ['an email outside the allowlist', 'mallory.signup@example.test', viaApi],
    ['any email while the allowlist is empty', 'nadia.signup@example.test', viaClosed],
  ])('answers %s exactly like an invited one and creates nothing', async (_, email, send) => {
    const body = await expectGenericAnswer(await signUp(email, password, send));
    expect(body.user.email).toBe(email);
    expect(await usersNamed(email)).toBe(0);
    expect((await signIn(email)).status).toBe(401);
  });

  it('answers a second sign-up of a registered email alike and keeps the first password', async () => {
    await expectGenericAnswer(await signUp('ines.signup@example.test', 'another-password-9'));
    expect(await usersNamed('ines.signup@example.test')).toBe(1);
    expect((await signIn('ines.signup@example.test', 'another-password-9')).status).toBe(401);
    expect((await signIn('ines.signup@example.test')).status).toBe(200);
  });

  it('refuses an over-long name or a non-https or over-long image alike for invited, uninvited and registered emails, and on update', async () => {
    const longName = 'n'.repeat(LIMITS.displayName + 1);
    const imageUrl = (length: number) => `https://img.example.test/${'i'.repeat(length - 25)}`;
    const refused: Record<string, string>[] = [
      { name: longName },
      { image: 'javascript:alert(1)' },
      { image: imageUrl(LIMITS.url + 1) },
    ];
    for (const email of [
      'lena.signup@example.test',
      'oscar.signup@example.test',
      'ines.signup@example.test',
    ]) {
      for (const field of refused) {
        const body = { name: 'Fixture Person', email, password, ...field };
        expect((await post('/api/auth/sign-up/email', body)).status).toBe(400);
      }
    }
    expect(await usersNamed('lena.signup@example.test')).toBe(0);
    await expectGenericAnswer(
      await signUp('lena.signup@example.test', password, viaApi, longName.slice(1)),
    );
    expect(await usersNamed('lena.signup@example.test')).toBe(1);

    const signedIn = await signIn('lena.signup@example.test');
    const cookie = signedIn.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
    const update = (body: Record<string, string>) =>
      post('/api/auth/update-user', body, viaApi, { cookie, origin: env.BETTER_AUTH_URL });
    const stored = () =>
      query(sql`select name, image from users where email = 'lena.signup@example.test'`);
    for (const field of refused) expect((await update(field)).status).toBe(400);
    expect(await stored()).toEqual([{ name: longName.slice(1), image: null }]);
    const fitting = { name: 'm'.repeat(LIMITS.displayName), image: imageUrl(LIMITS.url) };
    expect((await update(fitting)).status).toBe(200);
    expect(await stored()).toEqual([fitting]);
  });

  it('holds on the server-side sign-up path too', async () => {
    const result = await auth.api.signUpEmail({
      body: { name: 'Fixture Person', email: 'trent.signup@example.test', password },
    });
    expect(result.token).toBeNull();
    expect(await usersNamed('trent.signup@example.test')).toBe(0);
  });

  it('offers no other way to create a user: a fixed endpoint list and no social provider', async () => {
    expect(Object.keys(auth.api).sort()).toEqual([
      'accountInfo',
      'callbackOAuth',
      'changeEmail',
      'changePassword',
      'deleteUser',
      'deleteUserCallback',
      'error',
      'getAccessToken',
      'getSession',
      'linkSocialAccount',
      'listSessions',
      'listUserAccounts',
      'ok',
      'refreshToken',
      'requestPasswordReset',
      'requestPasswordResetCallback',
      'resetPassword',
      'revokeOtherSessions',
      'revokeSession',
      'revokeSessions',
      'sendVerificationEmail',
      'setPassword',
      'signInEmail',
      'signInSocial',
      'signOut',
      'signUpEmail',
      'unlinkAccount',
      'updateSession',
      'updateUser',
      'verifyEmail',
      'verifyPassword',
    ]);
    expect((await post('/api/auth/sign-in/social', { provider: 'github' })).status).toBe(404);
  });
});

describe('owner seed', () => {
  it('prints a failed write without its query or params, then creates a user who signs in and refuses to touch that user again', async () => {
    await drizzle(pool).transaction(async (tx) => {
      await tx.execute(sql`lock table accounts in share mode`);
      const blocked = seedOwner(password);
      await vi.waitFor(async () => {
        const cancelled = await query(sql`select pg_cancel_backend(pid) from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%accounts%'`);
        expect(cancelled).toEqual([{ pg_cancel_backend: true }]);
      }, 15_000);
      expect(await blocked).toEqual({
        status: 1,
        output: 'Seed failed: Error (57014).\n',
      });
    });
    expect(await seedOwner(password)).toEqual({
      status: 0,
      output: 'Seeded owner.signup@example.test.\n',
    });
    expect((await signIn('owner.signup@example.test')).status).toBe(200);

    expect(await seedOwner('another-password-9')).toEqual({
      status: 1,
      output: 'Refused: a user with that email already exists.\n',
    });
    expect(await usersNamed('owner.signup@example.test')).toBe(1);
    expect((await signIn('owner.signup@example.test', 'another-password-9')).status).toBe(401);
    expect((await signIn('owner.signup@example.test')).status).toBe(200);
  });
});
