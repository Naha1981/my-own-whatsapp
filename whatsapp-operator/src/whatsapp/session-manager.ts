import makeWASocket, { DisconnectReason, WASocket, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { config } from '../config.js';
import { clearPostgresAuthState, usePostgresAuthState } from './auth-state.js';
import { updateAccount, listConnectableAccounts } from '../db/accounts.js';
import { forwardInboundMessage } from '../webhook/forward.js';

const logger = pino({ level: config.logLevel });
const RECONNECT_DELAY_MS = 5_000;
const VERSION_FETCH_TIMEOUT_MS = 15_000;

const sockets = new Map<string, WASocket>();
const stopping = new Set<string>();

export function getSocket(waAccountId: string): WASocket | undefined {
  return sockets.get(waAccountId);
}

async function fetchLiveWhatsAppWebVersion(): Promise<number[] | undefined> {
  try {
    const response = await fetch('https://web.whatsapp.com/sw.js', {
      method: 'GET',
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

    const version = [2, 3000, Number(match[1])];
    logger.info({ version: version.join('.') }, 'Resolved live WhatsApp Web version');
    return version;
  } catch (err) {
    logger.warn({ err }, 'Live WhatsApp Web version lookup failed');
    return undefined;
  }
}

async function resolveBaileysVersion(): Promise<number[] | undefined> {
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
    qrTimeout: 20_000,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    logger: logger.child({ waAccountId }) as any,
  });

  sockets.set(waAccountId, sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      await updateAccount(waAccountId, {
        qr_code: qrDataUrl,
        is_connected: false,
        status: 'qr_ready',
      });
      logger.info({ waAccountId }, 'WhatsApp QR generated');
    }

    if (connection === 'open') {
      logger.info({ waAccountId }, 'WhatsApp connected');
      await updateAccount(waAccountId, {
        is_connected: true,
        qr_code: null,
        phone_number: sock.user?.id?.split(':')[0] ?? null,
        status: 'connected',
      });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const errorMessage = lastDisconnect?.error instanceof Error
        ? lastDisconnect.error.message
        : String(lastDisconnect?.error ?? 'unknown');

      // Keep this before the stale-socket guard: the PDF's playbook depends on
      // seeing every close reason, including closes from replaced sockets.
      logger.warn({ waAccountId, statusCode, errorMessage }, 'WhatsApp connection closed');

      const isCurrentSocket = sockets.get(waAccountId) === sock;
      if (isCurrentSocket) sockets.delete(waAccountId);

      if (stopping.has(waAccountId)) {
        logger.info({ waAccountId, statusCode }, 'Ignoring close from intentionally stopped session');
        return;
      }

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
        });
        logger.warn({ waAccountId, statusCode }, 'WhatsApp connection replaced elsewhere — not reconnecting automatically');
        return;
      }

      await updateAccount(waAccountId, {
        is_connected: false,
        status: 'disconnected',
        qr_code: null,
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
    if (sock) {
      await sock.logout().catch(() => undefined);
      if (sockets.get(waAccountId) === sock) sockets.delete(waAccountId);
    }
    await clearPostgresAuthState(waAccountId);
    await updateAccount(waAccountId, {
      is_connected: false,
      status: 'logged_out',
      qr_code: null,
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
