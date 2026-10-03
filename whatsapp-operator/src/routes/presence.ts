import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { requireAccountAccess } from '../middleware/account-access.js';
import {
  disablePresenceTarget,
  getPresenceReport,
  listPresenceTargets,
  upsertPresenceTarget,
} from '../db/presence-intelligence.js';
import { getSocket } from '../whatsapp/session-manager.js';

export const presenceRouter = Router();

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('days must be a number');
  return Math.floor(parsed);
}

function jidFromInput(value: unknown): string {
  const input = requiredString(value, 'jid/to');
  if (input.includes('@s.whatsapp.net') || input.includes('@g.us')) return input;
  const digits = input.replace(/\D/g, '');
  if (!/^\d{5,20}$/.test(digits)) {
    throw new Error('jid/to must contain a valid WhatsApp phone number');
  }
  return `${digits}@s.whatsapp.net`;
}

function tenantScope(req: Parameters<typeof requireAccountAccess>[0]) {
  const scope = (req as typeof req & { tenantScope?: { appId: string; tenantId: string } }).tenantScope;
  if (!scope) throw new Error('TENANT_AUTH_REQUIRED');
  return scope;
}

presenceRouter.post('/targets', requireAccountAccess((req) => String(req.body?.waAccountId ?? '') || undefined), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const scope = tenantScope(req);
  const waAccountId = requiredString(body.waAccountId, 'waAccountId');
  const jid = jidFromInput(body.jid ?? body.to);
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null;

  const socket = getSocket(waAccountId);
  if (!socket) {
    res.status(409).json({
      error: 'WHATSAPP_NOT_CONNECTED',
      message: 'Connect the WhatsApp account before subscribing to a presence target',
    });
    return;
  }

  await socket.presenceSubscribe(jid);
  const target = await upsertPresenceTarget({
    waAccountId,
    appId: scope.appId,
    tenantId: scope.tenantId,
    jid,
    label,
  });

  res.status(201).json({
    ok: true,
    target,
    message: 'Presence monitoring enabled. Activity evidence will accumulate while the target remains active.',
  });
}));

presenceRouter.get('/targets', requireAccountAccess((req) => String(req.query.waAccountId ?? '') || undefined), asyncHandler(async (req, res) => {
  const scope = tenantScope(req);
  const waAccountId = requiredString(req.query.waAccountId, 'waAccountId');
  const targets = await listPresenceTargets(scope.appId, scope.tenantId, waAccountId);
  res.json({ targets });
}));

presenceRouter.delete('/targets/:jid', requireAccountAccess((req) => String(req.query.waAccountId ?? '') || undefined), asyncHandler(async (req, res) => {
  const scope = tenantScope(req);
  const waAccountId = requiredString(req.query.waAccountId, 'waAccountId');
  await disablePresenceTarget(scope.appId, scope.tenantId, waAccountId, decodeURIComponent(req.params.jid));
  res.json({ ok: true });
}));

presenceRouter.get('/report', requireAccountAccess((req) => String(req.query.waAccountId ?? '') || undefined), asyncHandler(async (req, res) => {
  const scope = tenantScope(req);
  const report = await getPresenceReport({
    appId: scope.appId,
    tenantId: scope.tenantId,
    waAccountId: requiredString(req.query.waAccountId, 'waAccountId'),
    jid: jidFromInput(req.query.jid),
    days: optionalInt(req.query.days, 30),
    timezone: typeof req.query.timezone === 'string' ? req.query.timezone : undefined,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(report);
}));
