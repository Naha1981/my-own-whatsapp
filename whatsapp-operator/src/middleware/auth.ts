import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

/**
 * Every "Brain" app must send Authorization: Bearer <OPERATOR_API_KEY>
 * to create accounts, fetch QR codes, or send messages.
 * Fail closed: no key or wrong key -> reject, never allow through.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token || token !== config.operatorApiKey) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or invalid Operator API key' });
    return;
  }

  next();
}
