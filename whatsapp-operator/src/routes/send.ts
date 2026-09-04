import { Router } from 'express';
import { sendMessage } from '../whatsapp/session-manager.js';

export const sendRouter = Router();

// Called by a "Brain" app to reply to a customer.
// POST /send  { waAccountId, to, text }
sendRouter.post('/', async (req, res) => {
  const { waAccountId, to, text } = req.body ?? {};

  if (!waAccountId || !to || !text) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'waAccountId, to and text are required' });
    return;
  }

  try {
    await sendMessage(waAccountId, to, text);
    res.json({ ok: true });
  } catch (err) {
    res.status(422).json({ error: 'SEND_FAILED', message: (err as Error).message });
  }
});
