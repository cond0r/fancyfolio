import { siteKey } from '@fancyfolio/contracts';
import { notFound } from 'next/navigation';
import * as v from 'valibot';
import { getSite } from '../../../lib/api';

export const ensureStatic = 'navigation';
export const instant = false;

export function generateStaticParams() {
  return [{ site: '_' }];
}

export default async function SiteHome({ params }: { params: Promise<{ site: string }> }) {
  const { site: key } = await params;
  const site = v.is(siteKey, key) ? await getSite(key) : null;
  if (site === null) notFound();
  const { displayName, headline, location } = site.profile;
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <header>
        <h1 className="text-4xl font-semibold tracking-tight">{displayName}</h1>
        <p className="mt-4 text-lg text-neutral-600">{headline}</p>
        <p className="mt-1 text-neutral-500">{location}</p>
      </header>
    </main>
  );
}
