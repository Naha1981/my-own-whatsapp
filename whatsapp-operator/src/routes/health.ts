import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'nahalabs-whatsapp-operator',
    timestamp: new Date().toISOString(),
  });
});
