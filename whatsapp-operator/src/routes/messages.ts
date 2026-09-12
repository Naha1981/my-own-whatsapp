import { Router } from 'express';
import type { WAMessageKey } from '@whiskeysockets/baileys';
import { getSocket } from '../whatsapp/session-manager.js';
import { requireAccountAccess } from '../middleware/account-access.js';

export const messagesRouter = Router();

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function recipientJid(value: unknown): string {
  const input = requiredString(value, 'to');
  if (input.includes('@s.whatsapp.net') || input.includes('@g.us')) return input;
  const digits = input.replace(/\D/g, '');
  if (!/^\d{5,20}$/.test(digits)) throw new Error('to must contain a valid WhatsApp phone number or JID');
  return `${digits}@s.whatsapp.net`;
}

function messageKey(body: Record<string, unknown>): WAMessageKey {
  const id = requiredString(body.messageId, 'messageId');
  const remoteJid = requiredString(body.messageRemoteJid, 'messageRemoteJid');
  return {
    id,
    remoteJid,
    fromMe: body.messageFromMe === true,
    ...(body.messageParticipant ? { participant: String(body.messageParticipant) } : {}),
  };
}

function getActiveSocket(waAccountId: string) {
  const sock = getSocket(waAccountId);
  if (!sock) throw new Error(`No active WhatsApp session for account ${waAccountId}. Has it been connected?`);
  return sock;
}

messagesRouter.post('/read', requireAccountAccess((req) => String(req.body?.waAccountId ?? '') || undefined), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const waAccountId = requiredString(body.waAccountId, 'waAccountId');

  try {
    const keysInput = Array.isArray(body.messages) ? body.messages : [body];
    const keys = keysInput.map((item) => {
      const source = (item ?? {}) as Record<string, unknown>;
      return {
        id: requiredString(source.messageId, 'messageId'),
        remoteJid: requiredString(source.messageRemoteJid, 'messageRemoteJid'),
        fromMe: source.messageFromMe === true,
        ...(source.messageParticipant ? { participant: String(source.messageParticipant) } : {}),
      } as WAMessageKey;
    });

    const sock = getActiveSocket(waAccountId);
    await sock.readMessages(keys);
    res.json({ ok: true, count: keys.length });
  } catch (err) {
    res.status(422).json({ error: 'READ_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
});

messagesRouter.post('/presence', requireAccountAccess((req) => String(req.body?.waAccountId ?? '') || undefined), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const waAccountId = requiredString(body.waAccountId, 'waAccountId');

  try {
    const presence = requiredString(body.presence, 'presence');
    const allowed = new Set(['available', 'unavailable', 'composing', 'recording', 'paused']);
    if (!allowed.has(presence)) throw new Error(`presence must be one of: ${Array.from(allowed).join(', ')}`);

    const sock = getActiveSocket(waAccountId);
    const jid = body.to ? recipientJid(body.to) : undefined;
    await sock.sendPresenceUpdate(presence as Parameters<typeof sock.sendPresenceUpdate>[0], jid);
    res.json({ ok: true, presence, ...(jid ? { to: jid } : {}) });
  } catch (err) {
    res.status(422).json({ error: 'PRESENCE_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
});

messagesRouter.post('/edit', requireAccountAccess((req) => String(req.body?.waAccountId ?? '') || undefined), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const waAccountId = requiredString(body.waAccountId, 'waAccountId');

  try {
    const text = requiredString(body.text, 'text');
    const to = recipientJid(body.to);
    const key = messageKey(body);
    const sock = getActiveSocket(waAccountId);
    const result = await sock.sendMessage(to, { text, edit: key } as Parameters<typeof sock.sendMessage>[1]);
    res.json({ ok: true, message: result });
  } catch (err) {
    res.status(422).json({ error: 'EDIT_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
});

messagesRouter.post('/delete', requireAccountAccess((req) => String(req.body?.waAccountId ?? '') || undefined), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const waAccountId = requiredString(body.waAccountId, 'waAccountId');

  try {
    const to = recipientJid(body.to);
    const key = messageKey(body);
    const sock = getActiveSocket(waAccountId);
    const result = await sock.sendMessage(to, { delete: key } as Parameters<typeof sock.sendMessage>[1]);
    res.json({ ok: true, message: result });
  } catch (err) {
    res.status(422).json({ error: 'DELETE_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
});

export const messagesRouterReady = true;
