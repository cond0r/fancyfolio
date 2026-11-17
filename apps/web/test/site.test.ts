import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({ life: [] as string[], tags: [] as string[] }));

vi.mock('next/cache', () => ({
  cacheLife: (profile: string) => cache.life.push(profile),
  cacheTag: (...tags: string[]) => cache.tags.push(...tags),
}));

const { default: SiteHome } = await import('../app/sites/[site]/page.tsx');

const tenantId = '7d1f0a52-3c4b-4e7a-9a51-2f6c8d0e1b93';
const profile = { displayName: 'Ines Duarte', headline: 'Platform engineer', location: 'Porto' };
const bundle = {
  tenantId,
  subdomain: 'ines',
  domain: null,
  profile: { ...profile, bioMd: '', avatarUrl: null, links: [] },
  experiences: [],
  projects: [],
  caseStudies: [],
};

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async (_url: URL, _init: RequestInit) => Response.json(body, { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const render = (site: string) => SiteHome({ params: Promise.resolve({ site }) });

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://127.0.0.1:3201');
  vi.stubEnv('ROOT_DOMAIN', 'fancyfolio.test');
  cache.life.length = 0;
  cache.tags.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the site home', () => {
  it('renders the profile header from the uncached API read, tagged by site and tenant', async () => {
    const fetch = answer(200, bundle);
    expect(renderToStaticMarkup(await render('ines.example'))).toBe(
      '<main class="mx-auto max-w-2xl px-6 py-24"><header><h1 class="text-4xl font-semibold tracking-tight">Ines Duarte</h1><p class="mt-4 text-lg text-neutral-600">Platform engineer</p><p class="mt-1 text-neutral-500">Porto</p></header></main>',
    );
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url?.href).toBe('http://127.0.0.1:3201/api/v1/sites/ines.example');
    expect(init).toMatchObject({
      cache: 'no-store',
      signal: expect.any(AbortSignal),
      headers: { 'x-forwarded-host': 'fancyfolio.test' },
    });
    expect(cache).toEqual({ life: ['site'], tags: ['site:ines.example', `tenant:${tenantId}`] });
  });

  it.each([
    ['_', []],
    ['api', []],
    ['Ines', []],
    ['vera', ['site:vera']],
  ])('answers not found for %j, caching %j under the site profile', async (site, tags) => {
    const fetch = answer(404, { error: 'not_found' });
    await expect(render(site)).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    expect(fetch).toHaveBeenCalledTimes(tags.length);
    expect(cache).toEqual({ life: tags.length ? ['site'] : [], tags });
  });

  it.each([
    [500, { error: 'internal', detail: 'ECONNREFUSED 10.0.0.5' }, 'Site read failed: 500'],
    [200, { ...bundle, tenantId: 7 }, 'Site read failed: malformed bundle'],
  ])('throws a generic error when the API answers %i with %j', async (status, body, message) => {
    answer(status, body);
    await expect(render('ines')).rejects.toThrow(new Error(message));
  });

  it.each([undefined, 'ftp://127.0.0.1'])('refuses API_URL=%j before any read', async (value) => {
    const fetch = answer(200, bundle);
    vi.stubEnv('API_URL', value);
    await expect(render('ines')).rejects.toThrow('Invalid environment: API_URL');
    expect(fetch).not.toHaveBeenCalled();
  });
});
