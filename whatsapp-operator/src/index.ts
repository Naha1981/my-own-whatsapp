import express from 'express';
import cors from 'cors';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { requireApiKey } from './middleware/auth.js';
import { accountsRouter } from './routes/accounts.js';
import { sendRouter } from './routes/send.js';
import { messagesRouter } from './routes/messages.js';
import { mediaRouter } from './routes/media.js';
import { callsRouter } from './routes/calls.js';
import { healthRouter } from './routes/health.js';
import { pool } from './db/pool.js';
import { listAccounts } from './db/accounts.js';
import { restoreConnectableSessions, stopSession } from './whatsapp/session-manager.js';

const logger = pino({ level: config.logLevel });
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// No auth required — used by uptime monitors / your keep-alive scheduler.
app.use('/health', healthRouter);

// Browser-based operator test console. The API key is entered by the operator,
// held only in browser memory, and sent directly to this same-origin API.
app.get('/operator-console', (_req, res) => {
  res.sendFile(path.join(publicDir, 'operator-console.html'));
});

// Everything below requires the shared Operator API key.
app.use('/accounts', requireApiKey, accountsRouter);
app.use('/send', requireApiKey, sendRouter);
app.use('/messages', requireApiKey, messagesRouter);
app.use('/media', requireApiKey, mediaRouter);
app.use('/calls', requireApiKey, callsRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', path: req.path });
});

// Fail closed on unexpected errors — never leak internals to the caller.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

const server = app.listen(config.port, async () => {
  logger.info(`NahaLabs WhatsApp Operator listening on port ${config.port}`);
  await restoreConnectableSessions();
});

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown started');

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out; forcing process exit');
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  server.close((err) => {
    if (err) logger.warn({ err }, 'HTTP server close reported an error');
  });

  try {
    const accounts = await listAccounts();
    await Promise.all(accounts.map((account) => stopSession(account.id).catch((err) => {
      logger.warn({ err, waAccountId: account.id }, 'Failed to stop WhatsApp session during shutdown');
    })));
    await pool.end();
    clearTimeout(forceExit);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    clearTimeout(forceExit);
    logger.error({ err }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
