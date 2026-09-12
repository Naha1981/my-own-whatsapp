import { getContentType, type WAMessage } from '@whiskeysockets/baileys';

export interface NormalizedInboundMessage {
  provider: 'whatsapp-web';
  messageId: string | null;
  chatId: string | null;
  senderId: string | null;
  fromMe: boolean;
  pushName: string | null;
  timestamp: number | null;
  messageType: string | null;
  text: string | null;
  media: {
    mimetype: string | null;
    fileName: string | null;
    caption: string | null;
  } | null;
  quotedMessageId: string | null;
  quotedParticipant: string | null;
  rawMessage: WAMessage;
}

function extractText(message: WAMessage): string | null {
  const content = message.message;
  if (!content) return null;

  const direct = content.conversation;
  if (typeof direct === 'string') return direct;

  const extended = content.extendedTextMessage?.text;
  if (typeof extended === 'string') return extended;

  for (const value of Object.values(content)) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as { caption?: unknown; text?: unknown };
    if (typeof candidate.caption === 'string') return candidate.caption;
    if (typeof candidate.text === 'string') return candidate.text;
  }

  return null;
}

function extractMedia(message: WAMessage) {
  const content = message.message;
  if (!content) return null;

  for (const value of Object.values(content)) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as { mimetype?: unknown; fileName?: unknown; caption?: unknown };
    if ('mimetype' in candidate) {
      return {
        mimetype: typeof candidate.mimetype === 'string' ? candidate.mimetype : null,
        fileName: typeof candidate.fileName === 'string' ? candidate.fileName : null,
        caption: typeof candidate.caption === 'string' ? candidate.caption : null,
      };
    }
  }

  return null;
}

export function normalizeInboundMessage(message: WAMessage): NormalizedInboundMessage {
  const contextInfo = message.message?.extendedTextMessage?.contextInfo;
  const participant = message.key.participant ?? null;
  const messageTimestamp = typeof message.messageTimestamp === 'number'
    ? message.messageTimestamp
    : typeof message.messageTimestamp === 'bigint'
      ? Number(message.messageTimestamp)
      : null;

  return {
    provider: 'whatsapp-web',
    messageId: message.key.id ?? null,
    chatId: message.key.remoteJid ?? null,
    senderId: participant ?? message.key.remoteJid ?? null,
    fromMe: message.key.fromMe === true,
    pushName: message.pushName ?? null,
    timestamp: messageTimestamp,
    messageType: getContentType(message.message ?? {}) ?? null,
    text: extractText(message),
    media: extractMedia(message),
    quotedMessageId: contextInfo?.stanzaId ?? null,
    quotedParticipant: contextInfo?.participant ?? null,
    rawMessage: message,
  };
}
