import crypto from 'node:crypto';

/**
 * Verify the Operator's X-Webhook-Signature header. The Operator signs the
 * exact JSON body string it POSTs with HMAC-SHA256 (see
 * whatsapp-operator/src/security/hmac.ts), so we recompute over the raw body.
 */
export function verifyWebhookSignature(secret: string, rawBody: string, signature: string): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Constant-time API key check for the /v1/* agent endpoints. */
export function hasValidApiKey(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
