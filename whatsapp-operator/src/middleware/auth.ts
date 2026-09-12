import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

/**
 * Every Brain app must send X-API-Key or Authorization: Bearer with the
 * shared OPERATOR_API_KEY. Both forms are accepted for easy integration.
 * Secret comparison is constant-time.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const xApiKey = req.header('x-api-key') ?? '';
  const authorization = req.header('authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const token = xApiKey || bearer;

  const expected = Buffer.from(config.operatorApiKey, 'utf8');
  const supplied = Buffer.from(token, 'utf8');
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

  if (!valid) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or invalid Operator API key' });
    return;
  }

  next();
}
