import { healthResponse } from '@fancyfolio/contracts';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.ts';

const noForwarding = { 'x-forwarded-for': null, 'x-real-ip': null, 'x-vercel-forwarded-for': null };

afterEach(() => {
  vi.unstubAllEnvs();
});

function getHealth(headers: Record<string, string> = {}) {
  return app.request('/api/health', { headers });
}

describe('GET /api/health', () => {
  it('echoes the forwarding headers, origin and cookie names the caller sent', async () => {
    const res = await getHealth({
      'x-forwarded-for': '203.0.113.7, 198.51.100.9',
      'x-real-ip': '203.0.113.7',
      'x-vercel-forwarded-for': '203.0.113.8',
      origin: 'https://app.example.test',
      cookie: 'ff-a=1; ff-b=2',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(v.is(healthResponse, body)).toBe(true);
    expect(body).toEqual({
      ok: true,
      headers: {
        'x-forwarded-for': '203.0.113.7, 198.51.100.9',
        'x-real-ip': '203.0.113.7',
        'x-vercel-forwarded-for': '203.0.113.8',
      },
      origin: 'https://app.example.test',
      cookieNames: ['ff-a', 'ff-b'],
    });
  });

  it('reports absent headers as null and no cookies as an empty list', async () => {
    const res = await getHealth();
    expect(await res.json()).toEqual({
      ok: true,
      headers: noForwarding,
      origin: null,
      cookieNames: [],
    });
  });

  it('echoes cookie names and never a cookie value', async () => {
    const res = await getHealth({
      cookie:
        'session=value-secret-K9; nameless-value-K8; =empty-name-K7; __proto__=1; constructor=2',
    });
    const text = await res.text();
    expect(JSON.parse(text).cookieNames).toEqual(['session', '__proto__', 'constructor']);
    for (const value of ['value-secret-K9', 'nameless-value-K8', 'empty-name-K7']) {
      expect(text).not.toContain(value);
    }
  });

  it('returns hostile header values as inert JSON strings', async () => {
    const payload = '</script><script>alert(1)</script>"\\';
    const res = await getHealth({ origin: payload, 'x-real-ip': "' OR '1'='1" });
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json();
    expect(body.origin).toBe(payload);
    expect(body.headers['x-real-ip']).toBe("' OR '1'='1");
  });

  it('never mixes headers between concurrent requests', async () => {
    const [first, second] = await Promise.all([
      getHealth({ 'x-real-ip': '192.0.2.1', origin: 'https://one.example.test', cookie: 'one=1' }),
      getHealth({ 'x-real-ip': '192.0.2.2' }),
    ]);
    expect(await first.json()).toMatchObject({
      headers: { 'x-real-ip': '192.0.2.1' },
      origin: 'https://one.example.test',
      cookieNames: ['one'],
    });
    expect(await second.json()).toEqual({
      ok: true,
      headers: { ...noForwarding, 'x-real-ip': '192.0.2.2' },
      origin: null,
      cookieNames: [],
    });
  });

  it('sets the two probe cookies and forbids caching', async () => {
    const res = await getHealth();
    expect(res.headers.getSetCookie()).toEqual([
      '__Secure-ff-probe-a=1; Max-Age=60; Path=/api/health; HttpOnly; Secure; SameSite=Lax',
      '__Secure-ff-probe-b=1; Max-Age=60; Path=/api/health; HttpOnly; Secure; SameSite=Lax',
    ]);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers only GET', async () => {
    const res = await app.request('/api/health', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('the app module', () => {
  it('does not read PORT when it is imported', async () => {
    vi.stubEnv('PORT', 'not-a-port-Q7');
    vi.resetModules();
    const { default: fresh } = await import('../src/index.ts');
    const res = await fresh.request('/api/health');
    expect(res.status).toBe(200);
  });
});
