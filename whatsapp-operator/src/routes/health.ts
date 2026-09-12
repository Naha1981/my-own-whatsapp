import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.json({
    status: 'ok',
    service: 'nahalabs-whatsapp-operator',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});
