import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import pino from 'pino';
import { config } from '../config.js';
import { hasValidApiKey } from '../hmac.js';
import type { BranchConfig } from '../branches.js';
import type { Store } from '../store.js';
import { sendText } from '../operator.js';
import { ingestInbound } from './webhook.js';

const logger = pino({ level: config.logLevel });

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const xApiKey = req.header('x-api-key') ?? '';
  const authorization = req.header('authorization') ?? '';
  const token = xApiKey || (authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
  if (!hasValidApiKey(token, config.conciergeApiKey)) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or invalid concierge API key' });
    return;
  }
  next();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

export function apiRouter(branches: Map<string, BranchConfig>, store: Store): Router {
  const router = Router();
  router.use(requireApiKey);

  const getBranch = (req: Request, res: Response): BranchConfig | null => {
    const branchId = String(req.body?.branchId ?? req.params.branchId ?? req.query.branchId ?? '');
    const branch = branches.get(branchId);
    if (!branch) {
      res.status(404).json({ error: 'UNKNOWN_BRANCH', message: `No branch config for "${branchId}"`, knownBranches: [...branches.keys()] });
      return null;
    }
    return branch;
  };

  /** Discover branch configs — the agent reads menu/hours/rules/voice from here. */
  router.get('/branches', (_req, res) => {
    res.json({ branches: [...branches.values()] });
  });

  /** Poll for customer messages. Default: pending inbound across all branches. */
  router.get('/inbox', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
      const messages = await store.listInbox({
        branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : 'pending',
        limit,
      });
      res.json({ count: messages.length, messages });
    } catch (err) { next(err); }
  });

  /** Full conversation with one customer at one branch (both directions). */
  router.get('/conversations/:branchId/:phone', async (req, res, next) => {
    try {
      const branch = getBranch(req, res);
      if (!branch) return;
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const messages = await store.listConversation(branch.branchId, req.params.phone, limit);
      res.json({ branch: branch.branchId, customer: req.params.phone, count: messages.length, messages });
    } catch (err) { next(err); }
  });

  /**
   * Agent reply. Live branches: sent through the Operator as the branch's
   * WhatsApp. Test branches: recorded and returned with simulated:true —
   * nothing touches real WhatsApp.
   */
  router.post('/replies', async (req, res, next) => {
    try {
      const branch = getBranch(req, res);
      if (!branch) return;
      const to = requiredString(req.body?.to, 'to');
      const text = requiredString(req.body?.text, 'text');

      if (branch.mode === 'test') {
        const stored = await store.storeOutbound({ branchId: branch.branchId, customerPhone: to, text, status: 'simulated', payload: { reason: 'branch in test mode' } });
        await store.markConversationReplied(branch.branchId, to);
        res.json({ ok: true, simulated: true, branch: branch.branchId, message: stored });
        return;
      }

      try {
        const operatorResult = await sendText(branch, to, text);
        const stored = await store.storeOutbound({ branchId: branch.branchId, customerPhone: to, text, status: 'sent', payload: operatorResult });
        await store.markConversationReplied(branch.branchId, to);
        res.json({ ok: true, simulated: false, branch: branch.branchId, message: stored });
      } catch (err) {
        await store.storeOutbound({ branchId: branch.branchId, customerPhone: to, text, status: 'failed', payload: { error: err instanceof Error ? err.message : String(err) } });
        throw err;
      }
    } catch (err) { next(err); }
  });

  /** Archive a message that needs no reply (spam, receipts, etc.). */
  router.post('/messages/:id/status', async (req, res, next) => {
    try {
      const status = requiredString(req.body?.status, 'status');
      if (!['pending', 'replied', 'archived'].includes(status)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'status must be pending, replied or archived' });
        return;
      }
      const updated = await store.setMessageStatus(Number(req.params.id), status);
      if (!updated) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      res.json({ ok: true, message: updated });
    } catch (err) { next(err); }
  });

  /**
   * TEST MODE: simulate a customer WhatsApp message without any real WhatsApp
   * traffic. Runs through the exact same store + notify pipeline as the real
   * webhook. Only accepted for branches in test mode.
   */
  router.post('/test/inbound', async (req, res, next) => {
    try {
      const branch = getBranch(req, res);
      if (!branch) return;
      if (branch.mode !== 'test') {
        res.status(409).json({ error: 'BRANCH_IS_LIVE', message: `Branch ${branch.branchId} is live — simulated inbound is refused` });
        return;
      }
      const from = requiredString(req.body?.from, 'from');
      const text = requiredString(req.body?.text, 'text');
      const pushName = typeof req.body?.pushName === 'string' ? req.body.pushName : 'Test Customer';

      const result = await ingestInbound(store, branch, {
        waMessageId: `TEST-${crypto.randomUUID()}`,
        customerPhone: from,
        pushName,
        text,
        messageType: 'conversation',
        payload: { simulated: true, branch: branch.branchId },
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (err) { next(err); }
  });

  /** TEST MODE: inspect what the agent would have sent for a branch. */
  router.get('/test/outbox/:branchId', async (req, res, next) => {
    try {
      const branch = getBranch(req, res);
      if (!branch) return;
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const customer = typeof req.query.customer === 'string' && req.query.customer ? req.query.customer : null;
      const outbound = await store.listOutbound(branch.branchId, customer, limit);
      res.json({ branch: branch.branchId, count: outbound.length, outbound });
    } catch (err) { next(err); }
  });

  return router;
}
