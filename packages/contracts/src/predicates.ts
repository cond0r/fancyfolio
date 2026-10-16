import { LIMITS } from './limits.ts';
import { RESERVED_SUBDOMAINS } from './reserved.ts';

export const SUBDOMAIN_PATTERN = '^(?!..--)[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$';
export const SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';
export const HOSTNAME_PATTERN =
  '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$';
export const HTTPS_URL_PATTERN = '^https://[!-~]+$';
export const CHALLENGE_TOKEN_PATTERN = '^[A-Za-z0-9_-]{43,}$';
const LINK_URL_PATTERN = '^(https://|mailto:)[!-~]+$';
export const MARKDOWN_FENCE = ':::';

const subdomain = new RegExp(SUBDOMAIN_PATTERN);
const slug = new RegExp(SLUG_PATTERN);
const hostname = new RegExp(HOSTNAME_PATTERN);
const httpsUrl = new RegExp(HTTPS_URL_PATTERN);
const linkUrl = new RegExp(LINK_URL_PATTERN);
const challengeToken = new RegExp(CHALLENGE_TOKEN_PATTERN);

export function isSubdomain(value: string): boolean {
  return subdomain.test(value) && !RESERVED_SUBDOMAINS.includes(value);
}

export function isSlug(value: string): boolean {
  return value.length <= LIMITS.slug && slug.test(value);
}

export function isHostname(value: string): boolean {
  return value.length <= LIMITS.hostname && hostname.test(value);
}

export function isHttpsUrl(value: string): boolean {
  return value.length <= LIMITS.url && httpsUrl.test(value);
}

export function isLinkUrl(value: string): boolean {
  return value.length <= LIMITS.url && linkUrl.test(value);
}

export function withinFenceLimit(markdown: string): boolean {
  return markdown.split(MARKDOWN_FENCE).length - 1 <= LIMITS.markdownFences;
}

export function isChallengeToken(value: string): boolean {
  return value.length <= LIMITS.challengeToken && challengeToken.test(value);
}
