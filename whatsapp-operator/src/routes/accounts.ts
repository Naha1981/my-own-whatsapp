import { Router } from 'express';
import { createAccount, getAccount, createBinding } from '../db/accounts.js';
import { startSession, stopSession } from '../whatsapp/session-manager.js';

export const accountsRouter = Router();

/**
 * Called once when a business owner clicks "Connect WhatsApp" in your app's dashboard.
 * POST /accounts  { label?, appId, tenantId, webhookUrl }
 * -> { waAccountId, status }
 */
accountsRouter.post('/', async (req, res) => {
  const { label, appId, tenantId, webhookUrl } = req.body ?? {};

  if (!appId || !tenantId || !webhookUrl) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'appId, tenantId and webhookUrl are required',
    });
    return;
  }

  const account = await createAccount(label);
  await createBinding({ waAccountId: account.id, appId, tenantId, webhookUrl });

  res.status(201).json({ waAccountId: account.id, status: account.status });
});

/**
 * Starts (or resumes) the WhatsApp socket for this account.
 * Call this, then start polling GET /accounts/:id/qr.
 */
accountsRouter.post('/:id/connect', async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  await startSession(account.id);
  res.json({ waAccountId: account.id, status: 'connecting' });
});

/**
 * Poll this every 2-3 seconds from the dashboard while status is "qr_ready".
 * Render qrCode (a data: URL) directly in an <img> tag for the owner to scan.
 */
accountsRouter.get('/:id/qr', async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  res.json({
    status: account.status,
    isConnected: account.is_connected,
    qrCode: account.qr_code,
  });
});

accountsRouter.get('/:id/status', async (req, res) => {
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
});

/** Logs the WhatsApp session out. Owner will need to re-scan a fresh QR code. */
accountsRouter.post('/:id/disconnect', async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  await stopSession(account.id);
  res.json({ waAccountId: account.id, status: 'logged_out' });
});
