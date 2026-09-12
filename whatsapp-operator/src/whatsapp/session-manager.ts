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

// One persistent socket per WhatsApp account. Run one Operator process unless
// cross-instance socket ownership/locking is added later.
const sockets = new Map<string, WASocket>();
const stopping = new Set<string>();

export function getSocket(waAccountId: string): WASocket | undefined {
  return sockets.get(waAccountId);
}

async function resolveBaileysVersion(): Promise<number[] | undefined> {
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info({ version: version.join('.'), isLatest }, 'Resolved Baileys WhatsApp Web version');
    return version;
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve latest Baileys version; using library fallback');
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
      // The PDF specifically requires the disconnect reason to be logged before
      // any stale-socket guard because statusCode is the key diagnostic signal.
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const errorMessage = lastDisconnect?.error instanceof Error
        ? lastDisconnect.error.message
        : String(lastDisconnect?.error ?? 'unknown');
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
      const badSession = statusCode === 500;

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

        logger.warn({ waAccountId, statusCode }, 'Bad session (500) — credentials purged; restarting clean session');
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

  // Low-level pairing-success event is intentionally logged. This lets us tell
  // a valid QR from a WhatsApp-side refusal of the device link.
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

/** Called once on boot to reconnect every account that has saved credentials. */
export async function restoreConnectableSessions(): Promise<void> {
  const accounts = await listConnectableAccounts();
  for (const account of accounts) {
    logger.info({ waAccountId: account.id }, 'Restoring session on boot');
    await startSession(account.id).catch((err) =>
      logger.error({ err, waAccountId: account.id }, 'Failed to restore session on boot')
    );
  }
}
