import { Router } from 'express';
import { getSocket } from '../whatsapp/session-manager.js';
import { requireAccountAccess } from '../middleware/account-access.js';

export const callsRouter = Router();

/** Reject an incoming WhatsApp call. Baileys does not provide a dependable Node-side voice/video call bridge. */
callsRouter.post('/reject', requireAccountAccess((req) => String(req.body?.waAccountId ?? '') || undefined), async (req, res) => {
  const { waAccountId, callId, from } = req.body ?? {};
  if (!waAccountId || !callId || !from) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'waAccountId, callId and from are required' });
    return;
  }

  const sock = getSocket(String(waAccountId));
  if (!sock) {
    res.status(409).json({ error: 'SESSION_NOT_CONNECTED', message: 'WhatsApp session is not currently connected' });
    return;
  }

  try {
    await sock.rejectCall(String(callId), String(from));
    res.json({ ok: true });
  } catch (err) {
    res.status(422).json({ error: 'CALL_REJECT_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
});
