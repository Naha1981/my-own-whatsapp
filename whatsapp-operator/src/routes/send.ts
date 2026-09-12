import { Router } from 'express';
import { getSocket, sendMessage } from '../whatsapp/session-manager.js';
import { requireAccountAccess } from '../middleware/account-access.js';

export const sendRouter = Router();

function jidForRecipient(value: string): string {
  if (value.includes('@s.whatsapp.net') || value.includes('@g.us')) return value;
  const digits = value.replace(/\D/g, '');
  if (!digits) throw new Error('Recipient must contain a WhatsApp phone number');
  return `${digits}@s.whatsapp.net`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Text remains backwards compatible. Rich message types use Baileys' native
 * sendMessage content contract, while the application still talks only to HTTP.
 */
sendRouter.post('/', requireAccountAccess((req) => String(req.body?.waAccountId ?? '') || undefined), async (req, res) => {
  const body = req.body ?? {};
  const { waAccountId, to, type = 'text' } = body;

  if (!waAccountId || !to) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'waAccountId and to are required' });
    return;
  }

  try {
    if (type === 'text') {
      const text = requiredString(body.text, 'text');
      const jid = jidForRecipient(String(to));
      const sock = getSocket(waAccountId);
      if (!sock) throw new Error(`No active WhatsApp session for account ${waAccountId}. Has it been connected?`);
      const quoted = body.quotedMessage && typeof body.quotedMessage === 'object' ? { quoted: body.quotedMessage } : undefined;
      const result = await sock.sendMessage(jid, { text }, quoted as any);
      res.json({ ok: true, type: 'text', message: result });
      return;
    }

    const sock = getSocket(waAccountId);
    if (!sock) throw new Error(`No active WhatsApp session for account ${waAccountId}. Has it been connected?`);
    const jid = jidForRecipient(String(to));

    const content = (() => {
      switch (type) {
        case 'image':
          return { image: { url: requiredString(body.url, 'url') }, caption: optionalString(body.caption) };
        case 'video':
          return {
            video: { url: requiredString(body.url, 'url') },
            caption: optionalString(body.caption),
            gifPlayback: body.gifPlayback === true,
            ptv: body.ptv === true,
          };
        case 'audio':
          return {
            audio: { url: requiredString(body.url, 'url') },
            mimetype: optionalString(body.mimetype) ?? 'audio/ogg; codecs=opus',
            ptt: body.ptt === true,
          };
        case 'document':
          return {
            document: { url: requiredString(body.url, 'url') },
            mimetype: optionalString(body.mimetype) ?? 'application/octet-stream',
            fileName: requiredString(body.fileName, 'fileName'),
            caption: optionalString(body.caption),
          };
        case 'sticker':
          return { sticker: { url: requiredString(body.url, 'url') } };
        case 'location': {
          const latitude = Number(body.latitude);
          const longitude = Number(body.longitude);
          if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error('latitude must be between -90 and 90');
          if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('longitude must be between -180 and 180');
          return {
            location: {
              degreesLatitude: latitude,
              degreesLongitude: longitude,
              ...(optionalString(body.name) ? { name: optionalString(body.name) } : {}),
              ...(optionalString(body.address) ? { address: optionalString(body.address) } : {}),
            },
          };
        }
        case 'contact':
          return {
            contacts: {
              displayName: requiredString(body.displayName, 'displayName'),
              contacts: [{ vcard: requiredString(body.vcard, 'vcard') }],
            },
          };
        case 'poll': {
          if (!Array.isArray(body.values) || body.values.length < 2 || body.values.length > 12) {
            throw new Error('poll values must contain 2–12 options');
          }
          const values = body.values.map(String).map((value) => value.trim()).filter(Boolean);
          if (values.length < 2 || values.length !== body.values.length) throw new Error('poll values must be non-empty strings');
          const selectableCount = Number(body.selectableCount ?? 1);
          if (!Number.isInteger(selectableCount) || selectableCount < 1 || selectableCount > values.length) {
            throw new Error(`selectableCount must be an integer from 1 to ${values.length}`);
          }
          return {
            poll: {
              name: requiredString(body.name, 'name'),
              values,
              selectableCount,
            },
          };
        }
        case 'reaction':
          return {
            react: {
              text: requiredString(body.text, 'text'),
              key: {
                remoteJid: requiredString(body.messageRemoteJid, 'messageRemoteJid'),
                id: requiredString(body.messageId, 'messageId'),
                fromMe: body.messageFromMe === true,
                ...(body.messageParticipant ? { participant: String(body.messageParticipant) } : {}),
              },
            },
          };
        default:
          throw new Error(`Unsupported message type: ${String(type)}`);
      }
    })();

    const quoted = body.quotedMessage && typeof body.quotedMessage === 'object' ? { quoted: body.quotedMessage } : undefined;
    const result = await sock.sendMessage(jid, content as Parameters<typeof sock.sendMessage>[1], quoted as any);
    res.json({ ok: true, type, message: result });
  } catch (err) {
    res.status(422).json({ error: 'SEND_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
});
