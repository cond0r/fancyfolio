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
import {
  type Cut,
  cuttingProxy,
  watchUncaught,
} from '../../../../packages/db/test/cutting-proxy.ts';
import type {} from '../../../../packages/db/test/setup.ts';

const { mode, appUrl } = inject('db');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe.runIf(mode === 'local')('a public route whose connection is lost', () => {
  let proxy: Awaited<ReturnType<typeof cuttingProxy>>;
  let api: typeof import('../../src/index.ts')['default'];
  let uncaught: ReturnType<typeof watchUncaught>;

  beforeAll(async () => {
    proxy = await cuttingProxy(appUrl);
    vi.stubEnv('DATABASE_URL', proxy.url);
    ({ default: api } = await import('../../src/index.ts'));
  });

  beforeEach(() => {
    uncaught = watchUncaught();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    uncaught.stop();
    vi.restoreAllMocks();
  });

  afterAll(() => proxy.close());

  it.each<[string, Cut]>([
    ['bundle', 'socket killed'],
    ['bundle', 'FATAL 57P01 then close'],
    ['case study', 'socket killed'],
    ['case study', 'FATAL 57P01 then close'],
  ])(
    'answers the %s with a generic 500 when the %s, then serves the next request',
    async (route, cut) => {
      const key = `lost-${route.replace(' ', '-')}-${cut === 'socket killed' ? 'kill' : 'fatal'}`;
      const path = (site: string) =>
        route === 'bundle'
          ? `/api/v1/sites/${site}`
          : `/api/v1/sites/${site}/case-studies/any-slug`;
      proxy.cutOn(key, cut);
      const res = await api.request(path(key));
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
      const requestId = res.headers.get('x-request-id');
      expect(requestId).toMatch(uuid);
      expect(await res.json()).toEqual({ error: 'Internal error', requestId });
      expect((await api.request(path('nobody'))).status).toBe(404);
      expect(uncaught.seen).toEqual([]);
    },
  );
});
