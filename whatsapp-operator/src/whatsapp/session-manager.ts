import makeWASocket, { DisconnectReason, WASocket, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import type { WAVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { config } from '../config.js';
import { clearPostgresAuthState, usePostgresAuthState } from './auth-state.js';
import { updateAccount, listConnectableAccounts } from '../db/accounts.js';
import { forwardInboundMessage } from '../webhook/forward.js';

const logger = pino({ level: config.logLevel });
const RECONNECT_DELAY_MS = 5_000;
const QR_LIFETIME_MS = 20_000;
const PAIRING_CODE_LIFETIME_MS = 60_000;
const VERSION_FETCH_TIMEOUT_MS = 15_000;
const QR_SIZE_PX = 512;
const PAIRING_READY_TIMEOUT_MS = 15_000;

const sockets = new Map<string, WASocket>();
const stopping = new Set<string>();
const qrExpiryTimers = new Map<string, NodeJS.Timeout>();
const qrReadyAccounts = new Set<string>();

interface PairingCodeState {
  code: string;
  phoneNumber: string;
  expiresAt: number;
}

const pairingCodes = new Map<string, PairingCodeState>();

export function getSocket(waAccountId: string): WASocket | undefined {
  return sockets.get(waAccountId);
}

export function getPairingCode(waAccountId: string): PairingCodeState | undefined {
  const state = pairingCodes.get(waAccountId);
  if (!state) return undefined;
  if (state.expiresAt <= Date.now()) {
    pairingCodes.delete(waAccountId);
    return undefined;
  }
  return state;
}

function clearPairingCode(waAccountId: string): void {
  pairingCodes.delete(waAccountId);
}

function clearQrExpiryTimer(waAccountId: string): void {
  const timer = qrExpiryTimers.get(waAccountId);
  if (timer) clearTimeout(timer);
  qrExpiryTimers.delete(waAccountId);
}

function scheduleQrExpiry(waAccountId: string, sock: WASocket): void {
  clearQrExpiryTimer(waAccountId);
  const timer = setTimeout(async () => {
    if (sockets.get(waAccountId) !== sock) return;
    qrReadyAccounts.delete(waAccountId);
    await updateAccount(waAccountId, {
      qr_code: null,
      qr_generated_at: null,
      qr_expires_at: null,
      status: 'qr_expired',
    }).catch((err) => logger.error({ err, waAccountId }, 'Failed to clear expired QR'));
  }, QR_LIFETIME_MS);
  qrExpiryTimers.set(waAccountId, timer);
}

async function fetchLiveWhatsAppWebVersion(): Promise<WAVersion | undefined> {
  try {
    const response = await fetch('https://web.whatsapp.com/sw.js', {
      headers: {
        'sec-fetch-site': 'none',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`WhatsApp Web sw.js returned HTTP ${response.status}`);

    const body = await response.text();
    const match = body.match(/\\?"client_revision\\?":\s*(\d+)/);
    if (!match?.[1]) throw new Error('client_revision not found in WhatsApp Web sw.js');

    const version: WAVersion = [2, 3000, Number(match[1])];
    logger.info({ version: version.join('.') }, 'Resolved live WhatsApp Web version');
    return version;
  } catch (err) {
    logger.warn({ err }, 'Live WhatsApp Web version lookup failed');
    return undefined;
  }
}

async function resolveBaileysVersion(): Promise<WAVersion | undefined> {
  const liveVersion = await fetchLiveWhatsAppWebVersion();
  if (liveVersion) return liveVersion;

  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info({ version: version.join('.'), isLatest }, 'Resolved Baileys repository WhatsApp Web version');
    return version;
  } catch (err) {
    logger.warn({ err }, 'Baileys repository version lookup failed; using library internal fallback');
    return undefined;
  }
}

async function buildQrDataUrl(qr: string): Promise<string> {
  return QRCode.toDataURL(qr, {
    type: 'image/png',
    width: QR_SIZE_PX,
    margin: 4,
    errorCorrectionLevel: 'H',
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });
}

function normalizePairingPhoneNumber(value: string): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(digits)) {
    throw new Error('WhatsApp phone number must contain 8–15 digits including the country code');
  }
  return digits;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestPairingCode(waAccountId: string, phoneNumber: string): Promise<PairingCodeState> {
  const normalizedPhoneNumber = normalizePairingPhoneNumber(phoneNumber);
  const existing = getPairingCode(waAccountId);
  if (existing) {
    if (existing.phoneNumber !== normalizedPhoneNumber) {
      throw new Error('A pairing code is already active for this account; wait for it to expire before requesting another');
    }
    return existing;
  }

  if (!sockets.has(waAccountId)) {
    await startSession(waAccountId);
  }

  const deadline = Date.now() + PAIRING_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (sockets.has(waAccountId) && qrReadyAccounts.has(waAccountId)) break;
    await sleep(250);
  }

  const sock = sockets.get(waAccountId);
  if (!sock) throw new Error('WhatsApp session is not available; try connecting again');
  if (!qrReadyAccounts.has(waAccountId)) {
    throw new Error('WhatsApp session did not become ready for phone-number pairing in time');
  }

  const code = await sock.requestPairingCode(normalizedPhoneNumber);
  const state: PairingCodeState = {
    code,
    phoneNumber: normalizedPhoneNumber,
    expiresAt: Date.now() + PAIRING_CODE_LIFETIME_MS,
  };
  pairingCodes.set(waAccountId, state);

  clearQrExpiryTimer(waAccountId);
  await updateAccount(waAccountId, {
    qr_code: null,
    qr_generated_at: null,
    qr_expires_at: null,
    is_connected: false,
    status: 'pairing_code_ready',
  });

  logger.info({ waAccountId, phoneNumber: normalizedPhoneNumber, expiresAt: new Date(state.expiresAt).toISOString() }, 'WhatsApp pairing code generated');

  setTimeout(() => {
    const current = pairingCodes.get(waAccountId);
    if (current?.code === code && current.expiresAt <= Date.now()) {
      pairingCodes.delete(waAccountId);
      if (sockets.get(waAccountId) === sock) {
        updateAccount(waAccountId, { status: 'pairing_code_expired' }).catch((err) =>
          logger.error({ err, waAccountId }, 'Failed to mark expired pairing code')
        );
      }
    }
  }, PAIRING_CODE_LIFETIME_MS + 100);

  return state;
}

export async function startSession(waAccountId: string): Promise<void> {
  if (sockets.has(waAccountId)) {
    logger.info({ waAccountId }, 'Session already running, ignoring duplicate start');
    return;
  }

  const { state, saveCreds } = await usePostgresAuthState(waAccountId);
  if (sockets.has(waAccountId)) return;

  const version = await resolveBaileysVersion();
  if (sockets.has(waAccountId)) return;

  const sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    printQRInTerminal: false,
    browser: ['NahaLabs Operator', 'Chrome', '120.0.0.0'],
    qrTimeout: QR_LIFETIME_MS,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    logger: logger.child({ waAccountId }) as any,
  });

  sockets.set(waAccountId, sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrReadyAccounts.add(waAccountId);
      clearPairingCode(waAccountId);
      try {
        const qrDataUrl = await buildQrDataUrl(qr);
        const generatedAt = new Date();
        const expiresAt = new Date(generatedAt.getTime() + QR_LIFETIME_MS);

        await updateAccount(waAccountId, {
          qr_code: qrDataUrl,
          qr_generated_at: generatedAt.toISOString(),
          qr_expires_at: expiresAt.toISOString(),
          is_connected: false,
          status: 'qr_ready',
        });

        scheduleQrExpiry(waAccountId, sock);
        logger.info({ waAccountId, qrSizePx: QR_SIZE_PX, expiresAt: expiresAt.toISOString() }, 'WhatsApp QR generated');
      } catch (err) {
        logger.error({ err, waAccountId }, 'Failed to encode WhatsApp QR');
      }
    }

    if (connection === 'open') {
      qrReadyAccounts.delete(waAccountId);
      clearPairingCode(waAccountId);
      clearQrExpiryTimer(waAccountId);
      logger.info({ waAccountId }, 'WhatsApp connected');
      await updateAccount(waAccountId, {
        is_connected: true,
        qr_code: null,
        qr_generated_at: null,
        qr_expires_at: null,
        phone_number: sock.user?.id?.split(':')[0] ?? null,
        status: 'connected',
      });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const errorMessage = lastDisconnect?.error instanceof Error
        ? lastDisconnect.error.message
        : String(lastDisconnect?.error ?? 'unknown');

      logger.warn({ waAccountId, statusCode, errorMessage }, 'WhatsApp connection closed');

      const isCurrentSocket = sockets.get(waAccountId) === sock;
      if (isCurrentSocket) {
        sockets.delete(waAccountId);
        clearQrExpiryTimer(waAccountId);
        qrReadyAccounts.delete(waAccountId);
        clearPairingCode(waAccountId);
      }

      if (stopping.has(waAccountId)) return;
      if (!isCurrentSocket) {
        logger.info({ waAccountId, statusCode }, 'Ignoring close from stale socket');
        return;
      }

      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const badSession = statusCode === DisconnectReason.badSession || statusCode === 500;

      if (loggedOut || badSession) {
        await clearPostgresAuthState(waAccountId);
        await updateAccount(waAccountId, {
          is_connected: false,
          qr_code: null,
          qr_generated_at: null,
          qr_expires_at: null,
          phone_number: null,
          status: loggedOut ? 'logged_out' : 'pending',
        });

        if (loggedOut) {
          logger.warn({ waAccountId, statusCode }, 'WhatsApp logged out — credentials purged; fresh scan required');
          return;
        }

        logger.warn({ waAccountId, statusCode }, 'Bad session — credentials purged; restarting clean session');
        setTimeout(() => {
          startSession(waAccountId).catch((err) =>
            logger.error({ err, waAccountId }, 'Clean-session restart failed')
          );
        }, RECONNECT_DELAY_MS);
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        await updateAccount(waAccountId, {
          is_connected: false,
          status: 'disconnected',
          qr_code: null,
          qr_generated_at: null,
          qr_expires_at: null,
        });
        logger.warn({ waAccountId, statusCode }, 'WhatsApp connection replaced elsewhere — not reconnecting automatically');
        return;
      }

      await updateAccount(waAccountId, {
        is_connected: false,
        status: 'disconnected',
        qr_code: null,
        qr_generated_at: null,
        qr_expires_at: null,
      });
      logger.warn({ waAccountId, statusCode }, `Connection closed, reconnecting in ${RECONNECT_DELAY_MS}ms`);
      setTimeout(() => {
        startSession(waAccountId).catch((err) => logger.error({ err, waAccountId }, 'Reconnect failed'));
      }, RECONNECT_DELAY_MS);
    }
  });

  (sock.ev as any).on('CB:iq,,pair-success', (node: unknown) => {
    logger.info({ waAccountId, node }, 'WhatsApp pairing success received');
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      await forwardInboundMessage(waAccountId, msg).catch((err) =>
        logger.error({ err, waAccountId }, 'Failed to forward inbound message to Brain app')
      );
    }
  });
}

export async function stopSession(waAccountId: string): Promise<void> {
  const sock = sockets.get(waAccountId);
  stopping.add(waAccountId);
  try {
    clearQrExpiryTimer(waAccountId);
    qrReadyAccounts.delete(waAccountId);
    clearPairingCode(waAccountId);
    if (sock) {
      await sock.logout().catch(() => undefined);
      if (sockets.get(waAccountId) === sock) sockets.delete(waAccountId);
    }
    await clearPostgresAuthState(waAccountId);
    await updateAccount(waAccountId, {
      is_connected: false,
      status: 'logged_out',
      qr_code: null,
      qr_generated_at: null,
      qr_expires_at: null,
      phone_number: null,
    });
  } finally {
    stopping.delete(waAccountId);
  }
}

export async function resetSession(waAccountId: string): Promise<void> {
  await stopSession(waAccountId);
  await updateAccount(waAccountId, { status: 'pending' });
}

export async function sendMessage(waAccountId: string, to: string, text: string) {
  const sock = sockets.get(waAccountId);
  if (!sock) {
    throw new Error(`No active WhatsApp session for account ${waAccountId}. Has it been connected?`);
  }

  const digits = to.replace(/\D/g, '');
  if (!digits) throw new Error('Recipient must contain a WhatsApp phone number');
  const jid = to.includes('@s.whatsapp.net') ? to : `${digits}@s.whatsapp.net`;
  return sock.sendMessage(jid, { text });
}

export async function restoreConnectableSessions(): Promise<void> {
  const accounts = await listConnectableAccounts();
  for (const account of accounts) {
    logger.info({ waAccountId: account.id }, 'Restoring session on boot');
    await startSession(account.id).catch((err) =>
      logger.error({ err, waAccountId: account.id }, 'Failed to restore session on boot')
    );
  }
}
