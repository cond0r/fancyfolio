import { parseEnv, type SiteBundle, siteBundle } from '@fancyfolio/contracts';
import { cacheLife, cacheTag } from 'next/cache';
import * as v from 'valibot';
import { apiEnv } from '../env.ts';

export async function getSite(key: string): Promise<SiteBundle | null> {
  'use cache';
  cacheLife('site');
  cacheTag(`site:${key}`);
  const { API_URL, ROOT_DOMAIN } = parseEnv(apiEnv, process.env);
  const res = await fetch(new URL(`/api/v1/sites/${encodeURIComponent(key)}`, API_URL), {
    cache: 'no-store',
    headers: { 'x-forwarded-host': ROOT_DOMAIN },
    signal: AbortSignal.timeout(5_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Site read failed: ${res.status}`);
  const site = v.safeParse(siteBundle, await res.json());
  if (!site.success) throw new Error('Site read failed: malformed bundle');
  cacheTag(`tenant:${site.output.tenantId}`);
  return site.output;
}
