import { parseEnv, siteKey } from '@fancyfolio/contracts';
import { revalidateTag } from 'next/cache';
import * as v from 'valibot';
import { revalidateEnv } from '../../env.ts';
import { verifySignature } from '../../lib/signature.ts';

const maxBodyBytes = 2048;
const tenantTag = /^tenant:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tag = v.pipe(
  v.string(),
  v.check((tag) => tenantTag.test(tag) || (tag.startsWith('site:') && v.is(siteKey, tag.slice(5)))),
);
const revalidation = v.strictObject({
  tags: v.pipe(v.array(tag), v.minLength(1), v.maxLength(10)),
});

function parse(body: Uint8Array) {
  try {
    const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return v.safeParse(revalidation, json);
  } catch {
    return null;
  }
}

async function readCapped(request: Request) {
  if (Number(request.headers.get('content-length')) > maxBodyBytes) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBodyBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function POST(request: Request) {
  const body = await readCapped(request);
  if (!body) return new Response(null, { status: 400 });
  const { REVALIDATE_SECRET } = parseEnv(revalidateEnv, process.env);
  const signature = request.headers.get('x-fancyfolio-signature');
  if (!verifySignature(signature, body, REVALIDATE_SECRET, Math.floor(Date.now() / 1000))) {
    return new Response(null, { status: 401 });
  }
  const parsed = parse(body);
  if (!parsed?.success) return new Response(null, { status: 400 });
  for (const tag of parsed.output.tags) revalidateTag(tag, { expire: 0 });
  return new Response(null, { status: 204 });
}
