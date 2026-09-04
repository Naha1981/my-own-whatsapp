import makeWASocket, { DisconnectReason, WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { config } from '../config.js';
import { usePostgresAuthState } from './auth-state.js';
import { updateAccount, listConnectableAccounts } from '../db/accounts.js';
import { forwardInboundMessage } from '../webhook/forward.js';

const logger = pino({ level: config.logLevel });

// In-memory map of live sockets. This is the ONE thing that cannot be shared
// across multiple Operator instances — run exactly one Operator process,
// scale it vertically, not horizontally, unless you add socket affinity/locking.
const sockets = new Map<string, WASocket>();

export function getSocket(waAccountId: string): WASocket | undefined {
  return sockets.get(waAccountId);
}

export async function startSession(waAccountId: string): Promise<void> {
  if (sockets.has(waAccountId)) {
    logger.info({ waAccountId }, 'Session already running, ignoring duplicate start');
    return;
  }

  const { state, saveCreds } = await usePostgresAuthState(waAccountId);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['NahaLabs Operator', 'Chrome', '120.0.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    logger: logger.child({ waAccountId }) as any,
  });

  sockets.set(waAccountId, sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      await updateAccount(waAccountId, { qr_code: qrDataUrl, is_connected: false, status: 'qr_ready' });
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
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      sockets.delete(waAccountId);

      if (loggedOut) {
        logger.warn({ waAccountId }, 'Device logged out from phone — will NOT auto-reconnect. Owner must re-scan.');
        await updateAccount(waAccountId, { is_connected: false, status: 'logged_out' });
        return;
      }

      logger.warn({ waAccountId, statusCode }, 'Connection closed, reconnecting in 5s');
      await updateAccount(waAccountId, { is_connected: false, status: 'disconnected' });
      setTimeout(() => {
        startSession(waAccountId).catch((err) => logger.error({ err, waAccountId }, 'Reconnect failed'));
      }, 5000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue; // ignore our own outbound echoes
      await forwardInboundMessage(waAccountId, msg).catch((err) =>
        logger.error({ err, waAccountId }, 'Failed to forward inbound message to Brain app')
      );
    }
  });
}

export async function stopSession(waAccountId: string): Promise<void> {
  const sock = sockets.get(waAccountId);
  if (sock) {
    await sock.logout().catch(() => undefined);
    sockets.delete(waAccountId);
  }
  await updateAccount(waAccountId, { is_connected: false, status: 'logged_out' });
}

export async function sendMessage(waAccountId: string, to: string, text: string) {
  const sock = sockets.get(waAccountId);
  if (!sock) {
    throw new Error(`No active WhatsApp session for account ${waAccountId}. Has it been connected?`);
  }

  const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
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
