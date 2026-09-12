import { Router } from 'express';
import { createAccount, getAccount, createBinding } from '../db/accounts.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { getPairingCode, requestPairingCode, resetSession, startSession, stopSession } from '../whatsapp/session-manager.js';

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

function setNoStore(res: { setHeader(name: string, value: string): void }): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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

/** Request a WhatsApp Web phone-number pairing code instead of scanning QR. */
accountsRouter.post('/:id/pairing-code', asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  if (account.is_connected) {
    res.status(409).json({
      error: 'ALREADY_CONNECTED',
      message: 'This WhatsApp account is already connected',
    });
    return;
  }

  const { phoneNumber } = req.body ?? {};
  if (!phoneNumber || !String(phoneNumber).trim()) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'phoneNumber is required in international format',
    });
    return;
  }

  try {
    const pairing = await requestPairingCode(account.id, String(phoneNumber));
    setNoStore(res);
    res.json({
      waAccountId: account.id,
      status: 'pairing_code_ready',
      pairingCode: pairing.code,
      pairingCodeDisplay: pairing.code.match(/.{1,4}/g)?.join('-') ?? pairing.code,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
      instructions: [
        'Open WhatsApp on the business owner’s phone',
        'Open Linked Devices',
        'Choose Link a device',
        'Choose Link with phone number instead',
        'Enter the pairing code shown here',
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already active')) {
      res.status(409).json({ error: 'PAIRING_CODE_ACTIVE', message });
      return;
    }
    if (message.includes('8–15 digits')) {
      res.status(400).json({ error: 'INVALID_PHONE_NUMBER', message });
      return;
    }
    res.status(409).json({ error: 'PAIRING_NOT_READY', message });
  }
}));

/** Return the currently active phone pairing code, if one exists. */
accountsRouter.get('/:id/pairing-code', asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  const pairing = getPairingCode(account.id);
  setNoStore(res);
  res.json({
    waAccountId: account.id,
    status: pairing ? 'pairing_code_ready' : account.status,
    pairingCode: pairing?.code ?? null,
    pairingCodeDisplay: pairing?.code.match(/.{1,4}/g)?.join('-') ?? null,
    expiresAt: pairing ? new Date(pairing.expiresAt).toISOString() : null,
    isConnected: account.is_connected,
  });
}));

/** Poll every ~3 seconds while QR pairing. QR responses are never cacheable. */
accountsRouter.get('/:id/qr', asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  setNoStore(res);

  const expired = Boolean(account.qr_expires_at && new Date(account.qr_expires_at).getTime() <= Date.now());
  res.json({
    status: expired ? 'qr_expired' : account.status,
    isConnected: account.is_connected,
    qrCode: expired ? null : account.qr_code,
    qrGeneratedAt: expired ? null : account.qr_generated_at,
    qrExpiresAt: expired ? null : account.qr_expires_at,
    qrImageUrl: expired ? null : `/accounts/${account.id}/qr.png`,
    qrPollIntervalMs: 3000,
  });
}));

/** Direct PNG endpoint for frontends that prefer <img src> over a data URL. */
accountsRouter.get('/:id/qr.png', asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  const expired = Boolean(account.qr_expires_at && new Date(account.qr_expires_at).getTime() <= Date.now());
  if (!account.qr_code || expired || account.status !== 'qr_ready' || account.is_connected) {
    res.status(410).json({ error: 'QR_NOT_AVAILABLE', message: 'No fresh QR code is currently available' });
    return;
  }

  const separator = account.qr_code.indexOf(',');
  const base64 = separator >= 0 ? account.qr_code.slice(separator + 1) : account.qr_code;
  let png: Buffer;
  try {
    png = Buffer.from(base64, 'base64');
  } catch {
    res.status(500).json({ error: 'QR_DECODE_FAILED' });
    return;
  }

  setNoStore(res);
  res.type('png');
  res.send(png);
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

/** Reset to a clean, unpaired state and require a fresh QR scan or pairing code. */
accountsRouter.post('/:id/reset', asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  await resetSession(account.id);
  res.json({ waAccountId: account.id, status: 'pending' });
}));
