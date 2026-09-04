import crypto from 'node:crypto';

/**
 * Sign a JSON-serializable payload with HMAC-SHA256 so the receiving app
 * (the "Brain") can verify the message really came from this Operator.
 */
export function signPayload(secret: string, payload: unknown): string {
  const body = JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Constant-time signature comparison. Never use === on secrets/signatures.
 */
export function verifySignature(secret: string, payload: unknown, signature: string): boolean {
  const expected = signPayload(secret, payload);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
