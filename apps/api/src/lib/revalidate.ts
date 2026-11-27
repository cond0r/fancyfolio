import { createHmac } from 'node:crypto';
import { env } from '../env.ts';

const attempts = 2;
const timeoutMs = 2000;

async function attempt(body: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', env.REVALIDATE_SECRET).update(`${t}.${body}`).digest('hex');
  try {
    const response = await fetch(new URL('/revalidate', env.WEB_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fancyfolio-signature': `t=${t},v1=${v1}` },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return String(response.status);
  } catch (error) {
    return error instanceof Error ? error.name : 'Error';
  }
}

export async function revalidate(tags: string[], requestId: string): Promise<boolean> {
  const body = JSON.stringify({ tags: [...new Set(tags)] });
  const outcomes: string[] = [];
  while (outcomes.length < attempts) {
    const outcome = await attempt(body);
    if (outcome === '204') return true;
    outcomes.push(outcome);
  }
  console.error(JSON.stringify({ requestId, event: 'revalidate-failed', outcomes }));
  return false;
}
