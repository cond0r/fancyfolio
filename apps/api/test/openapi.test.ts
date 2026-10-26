import { describe, expect, it } from 'vitest';
import app from '../src/index.ts';

async function getDocument() {
  const res = await app.request('/api/openapi.json');
  expect(res.status).toBe(200);
  return { res, document: await res.json() };
}

describe('GET /api/openapi.json', () => {
  it('serves the document generated from the contracts, pinned by its snapshot', async () => {
    const { res, document } = await getDocument();
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(document).toMatchSnapshot();
  });

  it('names each response contract once and points every response at it', async () => {
    const { document } = await getDocument();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toEqual({
      title: 'Fancyfolio API',
      version: '1',
      description: 'Generated from the contracts that validate every request and response.',
    });
    expect(Object.keys(document.components.schemas)).toEqual([
      'HealthResponse',
      'ErrorBody',
      'SiteBundle',
      'CaseStudy',
    ]);
    const bundle = document.paths['/api/v1/sites/{key}'].get.responses;
    expect(bundle['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/SiteBundle',
    });
    expect(bundle['404'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ErrorBody',
    });
  });

  it('documents the path parameters from the validators and no 400 they never answer', async () => {
    const { document } = await getDocument();
    const caseStudy = document.paths['/api/v1/sites/{key}/case-studies/{slug}'].get;
    expect(caseStudy.parameters).toEqual([
      {
        in: 'path',
        name: 'key',
        required: true,
        schema: { type: 'string' },
        description: 'A subdomain or the live custom domain of a site',
      },
      {
        in: 'path',
        name: 'slug',
        required: true,
        schema: { type: 'string' },
        description:
          'Lower-case letters and digits in hyphen-separated groups, at most 64 characters',
      },
    ]);
    expect(JSON.stringify(document.paths)).not.toContain('"400"');
  });

  it('describes the fields as strictly as the response contracts enforce them', async () => {
    const { document } = await getDocument();
    const { SiteBundle, CaseStudy, ErrorBody } = document.components.schemas;
    expect(ErrorBody).toEqual({
      type: 'object',
      properties: { error: { type: 'string' }, requestId: { type: 'string' } },
      required: ['error', 'requestId'],
      additionalProperties: false,
    });
    expect(SiteBundle.additionalProperties).toBe(false);
    expect(SiteBundle.properties.profile.additionalProperties).toBe(false);
    expect(SiteBundle.properties.caseStudies.items.properties.publishedAt).toEqual({
      type: 'string',
    });
    expect(CaseStudy.required).toEqual([
      'slug',
      'title',
      'summary',
      'coverUrl',
      'experienceId',
      'publishedAt',
      'updatedAt',
      'bodyMd',
    ]);
    expect(JSON.stringify(document)).not.toMatch(/maxLength|maxItems/);
  });

  it('is the same public document for every caller, holds no secret and answers only GET', async () => {
    const anonymous = await (await app.request('/api/openapi.json')).text();
    const withCredentials = await app.request('/api/openapi.json', {
      headers: {
        cookie: 'session=s1-K2',
        authorization: 'Bearer t1-K3',
        origin: 'https://evil.example',
      },
    });
    const text = await withCredentials.text();
    expect(text).toBe(anonymous);
    for (const leak of ['unused-password-Z7', 'postgres://', '127.0.0.1', 's1-K2', 't1-K3']) {
      expect(text).not.toContain(leak);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const refused = await app.request('/api/openapi.json', { method });
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({
        error: 'Not found',
        requestId: refused.headers.get('x-request-id'),
      });
    }
  });
});
