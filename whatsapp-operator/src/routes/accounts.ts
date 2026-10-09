import { Router } from 'express';
import {
  createAccount,
  getAccount,
  listAccounts,
  listAccountsForScope,
  createBinding,
  getActiveBindings,
  issueTenantCredential,
} from '../db/accounts.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { requireAccountAccess, requireTenantScope } from '../middleware/account-access.js';
import { requireApiKey } from '../middleware/auth.js';
import { getPairingCode, requestPairingCode, resetSession, shutdownSession, startSession, stopSession } from '../whatsapp/session-manager.js';

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

/** List every account for trusted NahaLabs operator/admin tooling. */
accountsRouter.get('/', requireApiKey, asyncHandler(async (_req, res) => {
  const accounts = await listAccounts();
  setNoStore(res);
  res.json({
    accounts: accounts.map((account) => ({
      waAccountId: account.id,
      label: account.label,
      phoneNumber: account.phone_number,
      status: account.status,
      isConnected: account.is_connected,
    })),
  });
}));

/** List only the WhatsApp accounts bound to the caller's tenant credential. */
accountsRouter.get('/mine', requireTenantScope, asyncHandler(async (req, res) => {
  const scope = (req as typeof req & { tenantScope?: { appId: string; tenantId: string } }).tenantScope;
  if (!scope) {
    res.status(401).json({ error: 'TENANT_AUTH_REQUIRED' });
    return;
  }

  const accounts = await listAccountsForScope(scope.appId, scope.tenantId);
  setNoStore(res);
  res.json({
    appId: scope.appId,
    tenantId: scope.tenantId,
    accounts: accounts.map((account) => ({
      waAccountId: account.id,
      label: account.label,
      phoneNumber: account.phone_number,
      status: account.status,
      isConnected: account.is_connected,
    })),
  });
}));

/** Issue or rotate the tenant credential used by a product backend. Platform-key protected. */
accountsRouter.post('/tenant-token', requireApiKey, asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const appId = String(body.appId ?? '').trim();
  const tenantId = String(body.tenantId ?? '').trim();
  const rotate = body.rotate === true;

  if (!appId || !tenantId) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'appId and tenantId are required',
    });
    return;
  }

  const issued = await issueTenantCredential(appId, tenantId, rotate);
  if (!issued.token) {
    res.status(409).json({
      error: 'TENANT_TOKEN_ALREADY_EXISTS',
      message: 'A tenant token already exists. Set rotate=true to issue a replacement.',
    });
    return;
  }

  setNoStore(res);
  res.status(200).json({
    appId,
    tenantId,
    tenantToken: issued.token,
    created: issued.created,
    rotated: issued.rotated,
    warning: 'Store this token server-side. The Operator stores only its hash and cannot show the plaintext again.',
  });
}));

/**
 * Beginner-friendly first-time setup endpoint.
 * Reuses an existing account already bound to the requested app/tenant, otherwise creates one,
 * then starts the WhatsApp session so the next step is simply pairing the real phone.
 */
accountsRouter.post('/bootstrap', requireApiKey, asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const label = String(body.label ?? '').trim() || 'NahaLabs WhatsApp';
  const appId = String(body.appId ?? '').trim();
  const tenantId = String(body.tenantId ?? '').trim();

  if (!appId || !tenantId) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'appId and tenantId are required',
    });
    return;
  }
  const webhookUrlRaw = String(body.webhookUrl ?? '').trim();
  const webhookUrl = webhookUrlRaw || null;

  if (webhookUrl && !validateProductionWebhookUrl(webhookUrl)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Production webhookUrl must be a valid public HTTPS URL',
    });
    return;
  }

  const accounts = await listAccounts();
  let account = null;

  for (const candidate of accounts) {
    const bindings = await getActiveBindings(candidate.id);
    if (bindings.some((binding) => binding.app_id === appId && binding.tenant_id === tenantId)) {
      account = candidate;
      break;
    }
  }

  let created = false;
  if (!account) {
    account = await createAccount(label);
    created = true;
  }

  const tenantCredential = await issueTenantCredential(appId, tenantId);
  await createBinding({ waAccountId: account.id, appId, tenantId, webhookUrl });

  if (!account.is_connected && account.status !== 'connecting' && account.status !== 'qr_ready') {
    await startSession(account.id);
  }

  setNoStore(res);
  res.status(created ? 201 : 200).json({
    waAccountId: account.id,
    status: account.is_connected ? 'connected' : 'connecting',
    appId,
    tenantId,
    created,
    webhookConfigured: Boolean(webhookUrl),
    ...(tenantCredential.token ? { tenantToken: tenantCredential.token } : {}),
    tenantTokenCreated: tenantCredential.created,
    message: account.is_connected
      ? 'Your NahaLabs WhatsApp account is already connected.'
      : 'Setup is ready. Pair the business WhatsApp phone using the QR code or phone-number code.',
  });
}));

/** Create a WhatsApp account. Platform-key protected; returns a tenant credential only when one is first issued. */
accountsRouter.post('/', requireApiKey, asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const label = String(body.label ?? '').trim() || 'NahaLabs WhatsApp';
  const appId = String(body.appId ?? '').trim();
  const tenantId = String(body.tenantId ?? '').trim();

  if (!appId || !tenantId) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'appId and tenantId are required',
    });
    return;
  }

  const webhookUrlRaw = String(body.webhookUrl ?? '').trim();
  const webhookUrl = webhookUrlRaw || null;

  if (webhookUrl && !validateProductionWebhookUrl(webhookUrl)) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Production webhookUrl must be a valid public HTTPS URL',
    });
    return;
  }

  const account = await createAccount(label);
  const tenantCredential = await issueTenantCredential(appId, tenantId);
  await createBinding({ waAccountId: account.id, appId, tenantId, webhookUrl });
  res.status(201).json({
    waAccountId: account.id,
    status: account.status,
    appId,
    tenantId,
    webhookConfigured: Boolean(webhookUrl),
    ...(tenantCredential.token ? { tenantToken: tenantCredential.token } : {}),
    tenantTokenCreated: tenantCredential.created,
    message: webhookUrl
      ? 'Account created and connected to the supplied application webhook.'
      : 'Account created. WhatsApp can be connected now; the application webhook can be configured later.',
  });
}));

/** Starts the WhatsApp socket and begins generating a QR code. */
accountsRouter.post('/:id/connect', requireAccountAccess((req) => req.params.id), asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  // QR expiry clears the stored QR but intentionally leaves the socket alive.
  // Restart only an unconnected, expired pairing socket so "refresh QR" works
  // without logging out or deleting saved credentials for already-linked devices.
  const qrExpired =
    account.status === 'qr_expired' ||
    Boolean(account.qr_expires_at && new Date(String(account.qr_expires_at)).getTime() <= Date.now());

  if (!account.is_connected && qrExpired) {
    await shutdownSession(account.id);
  }

  await startSession(account.id);
  res.json({ waAccountId: account.id, status: 'connecting' });
}));

/** Request a WhatsApp Web phone-number pairing code instead of scanning QR. */
accountsRouter.post('/:id/pairing-code', requireAccountAccess((req) => req.params.id), asyncHandler(async (req, res) => {
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
accountsRouter.get('/:id/pairing-code', requireAccountAccess((req) => req.params.id), asyncHandler(async (req, res) => {
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
accountsRouter.get('/:id/qr', requireAccountAccess((req) => req.params.id), asyncHandler(async (req, res) => {
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
accountsRouter.get('/:id/qr.png', requireAccountAccess((req) => req.params.id), asyncHandler(async (req, res) => {
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
  const png = Buffer.from(base64, 'base64');

  setNoStore(res);
  res.type('png');
  res.send(png);
}));

accountsRouter.get('/:id/status', requireAccountAccess((req) => req.params.id), asyncHandler(async (req, res) => {
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
accountsRouter.post('/:id/disconnect', requireAccountAccess((req) => req.params.id), asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  await stopSession(account.id);
  res.json({ waAccountId: account.id, status: 'logged_out' });
}));

/** Reset to a clean, unpaired state and require a fresh QR scan or pairing code. */
accountsRouter.post('/:id/reset', requireAccountAccess((req) => req.params.id), asyncHandler(async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  await resetSession(account.id);
  res.json({ waAccountId: account.id, status: 'pending' });
}));
