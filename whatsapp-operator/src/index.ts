import express from 'express';
import cors from 'cors';
import pino from 'pino';
import { config } from './config.js';
import { requireApiKey } from './middleware/auth.js';
import { accountsRouter } from './routes/accounts.js';
import { sendRouter } from './routes/send.js';
import { healthRouter } from './routes/health.js';
import { restoreConnectableSessions } from './whatsapp/session-manager.js';

const logger = pino({ level: config.logLevel });
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// No auth required — used by uptime monitors / your keep-alive scheduler.
app.use('/health', healthRouter);

// Everything below requires the shared Operator API key.
app.use('/accounts', requireApiKey, accountsRouter);
app.use('/send', requireApiKey, sendRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', path: req.path });
});

// Fail closed on unexpected errors — never leak internals to the caller.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

app.listen(config.port, async () => {
  logger.info(`NahaLabs WhatsApp Operator listening on port ${config.port}`);
  await restoreConnectableSessions();
});
