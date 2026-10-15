import { expect, test } from '@playwright/test';

test('the landing page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fancyfolio');
});

test('the landing page logs no console error and serves its icon', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fancyfolio');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /^\/favicon\.ico(\?|$)/);
  const icon = await request.get('/favicon.ico');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toBe('image/x-icon');
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
});

test('the app host forwards /api/health to the API', async ({ request }) => {
  const res = await request.get('/api/health', { headers: { origin: 'http://localhost:3200' } });
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('no-store');
  const cookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
  expect(cookies.map((h) => h.value.split('=')[0])).toEqual([
    '__Secure-ff-probe-a',
    '__Secure-ff-probe-b',
  ]);
  expect(await res.json()).toMatchObject({ ok: true, origin: 'http://localhost:3200' });
});

test('a browser on the app host sends the probe cookies back through the rewrite', async ({
  page,
}) => {
  await page.goto('/api/health');
  const res = await page.goto('/api/health');
  expect(await res?.json()).toMatchObject({
    cookieNames: ['__Secure-ff-probe-a', '__Secure-ff-probe-b'],
  });
});

test('another host does not reach the API', async ({ request }) => {
  const res = await request.get('http://127.0.0.1:3200/api/health');
  expect(res.status()).toBe(404);
  expect(res.headers()['set-cookie']).toBeUndefined();
});
