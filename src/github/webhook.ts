import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(body: Buffer, signature: string | undefined, secret: string) {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(actual, expected);
}
