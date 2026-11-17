import { hostEnv, isHostname, isSubdomain, parseEnv, parseHost } from '@fancyfolio/contracts';
import { type NextRequest, NextResponse } from 'next/server';

function decodedSegments(pathname: string) {
  try {
    return decodeURIComponent(pathname).split('/').filter(Boolean);
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const { ROOT_DOMAIN } = parseEnv(hostEnv, process.env);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  const { hostname, port } = parseHost(host) ?? {};
  const segments = decodedSegments(request.nextUrl.pathname);
  const notFound = new NextResponse(null, { status: 404 });
  if (hostname === undefined || segments === null) return notFound;
  if (segments.some((segment) => segment === '.' || segment === '..')) return notFound;

  if (hostname === ROOT_DOMAIN) return segments[0] === 'sites' ? notFound : NextResponse.next();
  if (hostname === `www.${ROOT_DOMAIN}`) {
    const url = request.nextUrl.clone();
    url.hostname = ROOT_DOMAIN;
    url.port = port ?? '';
    return NextResponse.redirect(url, 308);
  }

  const subdomain = hostname.endsWith(`.${ROOT_DOMAIN}`)
    ? hostname.slice(0, -ROOT_DOMAIN.length - 1)
    : undefined;
  const site = subdomain ?? hostname;
  if (subdomain === undefined ? !isHostname(site) : !isSubdomain(site)) return notFound;
  const url = request.nextUrl.clone();
  const { pathname } = request.nextUrl;
  url.pathname = `/sites/${site}${pathname === '/' ? '' : pathname}`;
  return NextResponse.rewrite(url);
}

export const config = { matcher: '/((?!_next/).*)' };
