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
const calendarDate = /^([12]\d{3})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const versionToken =
  /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?[+-](0\d|1[0-5])(:[0-5]\d)?$/;

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

export function hasNoCredentials(value: string): boolean {
  if (value.includes('\\')) return false;
  const url = URL.parse(value);
  return url !== null && url.username === '' && url.password === '';
}

export function isLinkUrl(value: string): boolean {
  if (value.length > LIMITS.url || !linkUrl.test(value)) return false;
  return value.startsWith('mailto:') || hasNoCredentials(value);
}

export function withinFenceLimit(markdown: string): boolean {
  return markdown.split(MARKDOWN_FENCE).length - 1 <= LIMITS.markdownFences;
}

export function isChallengeToken(value: string): boolean {
  return value.length <= LIMITS.challengeToken && challengeToken.test(value);
}

export function isCalendarDate(value: string): boolean {
  const match = calendarDate.exec(value);
  if (match === null) return false;
  const [year, month, day] = match.slice(1).map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
}

export function isVersionToken(value: string): boolean {
  const match = versionToken.exec(value);
  return match !== null && isCalendarDate(match[1]);
}
