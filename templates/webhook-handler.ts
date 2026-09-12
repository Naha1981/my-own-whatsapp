/* NahaLabs inbound webhook template.
 * Adapt verifySignature() and idempotency storage to the consuming app.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type WhatsAppEvent = {
  schemaVersion: number;
  waAccountId: string;
  appId: string;
  tenantId: string;
  event: string;
  data: Record<string, unknown>;
  deliveredAt: string;
};

export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleWhatsAppWebhook(params: {
  rawBody: string;
  signature: string;
  secret: string;
  event: WhatsAppEvent;
  isDuplicate: (messageId: string) => Promise<boolean>;
  markProcessed: (messageId: string) => Promise<void>;
  dispatch: (event: WhatsAppEvent) => Promise<void>;
}) {
  if (!verifySignature(params.rawBody, params.signature, params.secret)) {
    throw new Error('Invalid WhatsApp webhook signature');
  }

  const messageId = typeof params.event.data?.messageId === 'string'
    ? params.event.data.messageId
    : '';

  if (messageId && await params.isDuplicate(messageId)) {
    return { ok: true, duplicate: true };
  }

  await params.dispatch(params.event);
  if (messageId) await params.markProcessed(messageId);
  return { ok: true, duplicate: false };
}
