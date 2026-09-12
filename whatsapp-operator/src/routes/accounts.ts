import { Router } from 'express';
import { createAccount, getAccount, createBinding } from '../db/accounts.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { resetSession, startSession, stopSession } from '../whatsapp/session-manager.js';

export const accountsRouter = Router();

function validateProductionWebhookUrl(webhookUrl: string): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  try {
    const url = new URL(webhookUrl);
    return url.protocol === 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';
  } catch {
    return false;
  }
}

/** Create a WhatsApp account and bind it to an application tenant. */
accountsRouter.post('/', asyncHandler(async (req, res) => {
  const { label, appId, tenantId, webhookUrl } = req.body ?? {};

  if (!appId || !tenantId || !webhookUrl) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'appId, tenantId and webhookUrl are required',
    });
    return;
  }

  if (!validateProductionWebhookUrl(webhookUrl)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Production webhookUrl must be a valid public HTTPS URL',
    });
    return;
  }

  const account = await createAccount(label);
  await createBinding({ waAccountId: account.id, appId, tenantId, webhookUrl });
  res.status(201).json({ waAccountId: account.id, status: account.status });
}));

/** Starts the WhatsApp socket and begins generating a QR code. */
accountsRouter.post('/:id/connect', asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  await startSession(account.id);
  res.json({ waAccountId: account.id, status: 'connecting' });
}));

/** Poll while pairing; refresh at least every few seconds. */
accountsRouter.get('/:id/qr', asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  res.json({ status: account.status, isConnected: account.is_connected, qrCode: account.qr_code });
}));

accountsRouter.get('/:id/status', asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  res.json({
    waAccountId: account.id,
    status: account.status,
    isConnected: account.is_connected,
    phoneNumber: account.phone_number,
  });
}));

/** Logs out and permanently clears saved Baileys credentials for the account. */
accountsRouter.post('/:id/disconnect', asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  await stopSession(account.id);
  res.json({ waAccountId: account.id, status: 'logged_out' });
}));

/** Reset to a clean, unpaired state and require a fresh QR scan. */
accountsRouter.post('/:id/reset', asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  await resetSession(account.id);
  res.json({ waAccountId: account.id, status: 'pending' });
}));
