import { parseEnv } from '@fancyfolio/contracts';
import * as v from 'valibot';

const label = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const hostname = new RegExp(`^${label}(\\.${label})*$`);
const loopback = ['127.0.0.1', 'localhost'];

function isApiUrl(value: string) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const ipLiteral = /^[\d.]+$/.test(url.hostname);
  return (
    url.origin === value &&
    url.port !== '0' &&
    url.hostname.length <= 253 &&
    hostname.test(url.hostname) &&
    (!ipLiteral || url.hostname === '127.0.0.1') &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && loopback.includes(url.hostname)))
  );
}

export const webEnv = v.object({
  API_URL: v.pipe(v.string(), v.check(isApiUrl)),
  ROOT_DOMAIN: v.pipe(v.string(), v.maxLength(253), v.regex(hostname)),
});

export const env = parseEnv(webEnv, process.env);
