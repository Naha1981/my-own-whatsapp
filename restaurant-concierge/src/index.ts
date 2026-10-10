import express from 'express';
import pino from 'pino';
import { config } from './config.js';
import { loadBranches } from './branches.js';
import * as db from './db.js';
import { webhookRouter } from './routes/webhook.js';
import { apiRouter } from './routes/api.js';

const logger = pino({ level: config.logLevel });

async function main(): Promise<void> {
  const branches = loadBranches(config.branchesDir);
  if (branches.size === 0) {
    logger.warn({ dir: config.branchesDir }, 'No branch configs found — webhook events will be ignored');
  }

  await db.migrate();
  logger.info('Restaurant Concierge database schema is ready (rc_* tables)');

  const app = express();
  app.disable('x-powered-by');

  // JSON for the agent API; the webhook route mounts its own raw-body parser
  // because signature verification needs the exact bytes the Operator signed.
  app.use((req, res, next) => {
    if (req.path.startsWith('/webhooks/')) return next();
    return express.json({ limit: '1mb' })(req, res, next);
  });

  app.get('/health', async (_req, res) => {
    try {
      await db.pool.query('SELECT 1');
      res.json({ ok: true, branches: [...branches.keys()], db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  app.use('/webhooks', webhookRouter(branches, db));
  app.use('/v1', apiRouter(branches, db));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'unknown' });
  });

  app.listen(config.port, () => {
    logger.info({ port: config.port, branches: [...branches.keys()] }, 'NahaLabs Restaurant Concierge listening');
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
