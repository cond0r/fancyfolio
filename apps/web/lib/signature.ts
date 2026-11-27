import { createHmac, timingSafeEqual } from 'node:crypto';

const signatureHeader = /^t=(\d{1,10}),v1=([0-9a-f]{64})$/;
const windowSeconds = 300;

export function verifySignature(
  signature: string | null,
  body: Uint8Array,
  secret: string,
  nowSeconds: number,
): boolean {
  const match = signatureHeader.exec(signature ?? '');
  if (!match) return false;
  if (Math.abs(nowSeconds - Number(match[1])) > windowSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${match[1]}.`).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex'));
}
