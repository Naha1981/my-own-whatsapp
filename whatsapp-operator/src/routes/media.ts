import { Router } from 'express';
import { downloadMediaMessage, getContentType, type WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { getSocket } from '../whatsapp/session-manager.js';
import { requireAccountAccess } from '../middleware/account-access.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
export const mediaRouter = Router();

mediaRouter.post('/download', requireAccountAccess((req) => String(req.body?.waAccountId ?? '') || undefined), async (req, res) => {
  const { waAccountId, message } = req.body ?? {};

  if (!waAccountId || !message) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'waAccountId and message are required' });
    return;
  }

  const sock = getSocket(String(waAccountId));
  if (!sock) {
    res.status(409).json({ error: 'SESSION_NOT_CONNECTED', message: 'WhatsApp session is not currently connected' });
    return;
  }

  try {
    const waMessage = message as WAMessage;
    const type = getContentType(waMessage.message ?? {});
    const media = await downloadMediaMessage(
      waMessage,
      'buffer',
      {},
      { logger: logger as never, reuploadRequest: sock.updateMediaMessage }
    );

    const content = waMessage.message ?? {};
    const typedContent = type ? content[type as keyof typeof content] as { mimetype?: string; fileName?: string } | undefined : undefined;
    const mimetype = typedContent?.mimetype ?? 'application/octet-stream';
    const fileName = typedContent?.fileName;

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', mimetype);
    if (fileName) {
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    }
    res.send(media);
  } catch (err) {
    logger.error({ err, waAccountId }, 'Failed to download WhatsApp media');
    res.status(422).json({ error: 'MEDIA_DOWNLOAD_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
});
