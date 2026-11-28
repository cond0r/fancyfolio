import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const route = 'http://localhost:3200/revalidate';
const secret = 'e2e-revalidate-secret-Z7-0123456789abcdef';
const body = JSON.stringify({ tags: ['site:ines'] });

function signed(data: string, t = Math.floor(Date.now() / 1000), key = secret) {
  const v1 = createHmac('sha256', key).update(`${t}.${data}`).digest('hex');
  return { 'content-type': 'application/json', 'x-fancyfolio-signature': `t=${t},v1=${v1}` };
}

test('the route refuses forged, expired and future-dated calls, bad tags and tenant hosts', async ({
  request,
}) => {
  for (const headers of [
    () => ({ 'content-type': 'application/json' }),
    () => signed(body, undefined, `${secret}-forged`),
    () => signed(body, Math.floor(Date.now() / 1000) - 301),
    // rounded up: the server may tick past a second boundary before it checks
    () => signed(body, Math.ceil(Date.now() / 1000) + 301),
  ]) {
    const res = await request.post(route, { headers: headers(), data: body });
    expect(res.status()).toBe(401);
    expect(await res.text()).toBe('');
  }
  const bad = JSON.stringify({ tags: ['site:INES'] });
  expect((await request.post(route, { headers: signed(bad), data: bad })).status()).toBe(400);
  expect((await request.post(route, { headers: signed(body), data: body })).status()).toBe(204);
  expect((await request.get(route)).status()).toBe(405);
  const tenantHost = { ...signed(body), 'x-forwarded-host': 'ines.localhost:3200' };
  expect((await request.post(route, { headers: tenantHost, data: body })).status()).toBe(404);
});

test('no file served to browsers carries the revalidation secret', () => {
  const staticDir = join(import.meta.dirname, '..', '..', 'apps', 'web', '.next', 'static');
  const files = readdirSync(staticDir, { recursive: true })
    .map((file) => join(staticDir, String(file)))
    .filter((file) => statSync(file).isFile());
  expect(files.filter((file) => file.endsWith('.js')).length).toBeGreaterThan(0);
  for (const file of files) expect(readFileSync(file, 'utf8')).not.toContain(secret);
});
