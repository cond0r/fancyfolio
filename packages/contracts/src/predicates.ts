import { RESERVED_SUBDOMAINS } from './reserved.ts';

export const SUBDOMAIN_PATTERN = '^(?!..--)[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$';

const subdomain = new RegExp(SUBDOMAIN_PATTERN);

export function isSubdomain(value: string): boolean {
  return subdomain.test(value) && !RESERVED_SUBDOMAINS.includes(value);
}
