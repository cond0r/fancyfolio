import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxy } from '../proxy.ts';

function outcome(host: string, path: string, forwardedHost?: string) {
  const headers = new Headers({ host });
  if (forwardedHost !== undefined) headers.set('x-forwarded-host', forwardedHost);
  const response = proxy(new NextRequest(`https://internal.test${path}`, { headers }));
  if (response.headers.get('x-middleware-next') === '1') return 'app';
  const rewrite = response.headers.get('x-middleware-rewrite');
  if (rewrite !== null) return `rewrite ${new URL(rewrite).pathname}${new URL(rewrite).search}`;
  const location = response.headers.get('location');
  return location === null ? `${response.status}` : `${response.status} ${location}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the proxy', () => {
  it.each([
    ['fancyfolio.test', '/', 'app'],
    ['FancyFolio.TEST.:3200', '/playground', 'app'],
    ['fancyfolio.test', '/sites/ines', '404'],
    ['fancyfolio.test', '/%73ites/ines', '404'],
    ['fancyfolio.test', '//sites/ines', '404'],
    ['fancyfolio.test', '/%E0%A4%A', '404'],
    ['www.fancyfolio.test', '/about?x=1', '308 https://fancyfolio.test/about?x=1'],
    ['WWW.fancyfolio.test.:3200', '/', '308 https://fancyfolio.test:3200/'],
    ['www.fancyfolio.test:99999', '/', '404'],
    ['www.fancyfolio.test:0', '/', '404'],
    ['ines.fancyfolio.test', '/', 'rewrite /sites/ines'],
    ['Ines.FancyFolio.test.:443', '/cv?tab=1', 'rewrite /sites/ines/cv?tab=1'],
    ['ines.fancyfolio.test:65536', '/', '404'],
    ['ines.fancyfolio.test', '/api/health', 'rewrite /sites/ines/api/health'],
    ['ines.fancyfolio.test', '/%2e%2e/dashboard', 'rewrite /sites/ines/dashboard'],
    ['ines.fancyfolio.test', '/..%2Fvera', '404'],
    ['ines.fancyfolio.test', '/%2e%2e%2fvera', '404'],
    ['api.fancyfolio.test', '/', '404'],
    ['a.b.fancyfolio.test', '/', '404'],
    ['-ines.fancyfolio.test', '/', '404'],
    ['ines.example', '/', 'rewrite /sites/ines.example'],
    ['blog.ines.example', '/', 'rewrite /sites/blog.ines.example'],
    ['evilfancyfolio.test', '/', 'rewrite /sites/evilfancyfolio.test'],
    ['fancyfolio.test.evil', '/', 'rewrite /sites/fancyfolio.test.evil'],
    ['127.0.0.1:3200', '/', '404'],
    ['', '/', '404'],
  ])('routes %j %j to %s', (host, path, expected) => {
    vi.stubEnv('ROOT_DOMAIN', 'fancyfolio.test');
    expect(outcome(host, path)).toBe(expected);
  });

  it.each([
    ['ines.fancyfolio.test', 'rewrite /sites/ines'],
    ['ines.fancyfolio.test, fancyfolio.test', '404'],
  ])('routes on the forwarded host %j over the host header', (forwardedHost, expected) => {
    vi.stubEnv('ROOT_DOMAIN', 'fancyfolio.test');
    expect(outcome('127.0.0.1:41000', '/', forwardedHost)).toBe(expected);
  });

  it.each([
    ['fancyfolio.test', 'fancyfolio-indol.vercel.app', 'app'],
    [undefined, 'fancyfolio.test', 'app'],
    [undefined, undefined, 'Error: Invalid environment: ROOT_DOMAIN (missing)'],
    ['fancyfolio.test:3200', undefined, 'Error: Invalid environment: ROOT_DOMAIN (malformed)'],
    [undefined, 'fancyfolio.test:3200', 'Error: Invalid environment: ROOT_DOMAIN (malformed)'],
  ])('takes ROOT_DOMAIN=%j, else %j: %s', (rootDomain, productionUrl, expected) => {
    vi.stubEnv('ROOT_DOMAIN', rootDomain);
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', productionUrl);
    let result: string;
    try {
      result = outcome('fancyfolio.test', '/');
    } catch (error) {
      result = String(error);
    }
    expect(result).toBe(expected);
  });
});
