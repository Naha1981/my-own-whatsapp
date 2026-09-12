import type { Request, Response, NextFunction } from 'express';
import { getActiveBindings } from '../db/accounts.js';

function scopeFromRequest(req: Request): { appId: string; tenantId: string } | null {
  const appId = String(req.header('x-app-id') ?? req.body?.appId ?? '').trim();
  const tenantId = String(req.header('x-tenant-id') ?? req.body?.tenantId ?? '').trim();
  if (!appId || !tenantId) return null;
  return { appId, tenantId };
}

export function requireAccountAccess(getAccountId: (req: Request) => string | undefined) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const waAccountId = getAccountId(req);
    if (!waAccountId) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'waAccountId is required',
      });
      return;
    }

    const scope = scopeFromRequest(req);
    if (!scope) {
      res.status(400).json({
        error: 'SCOPE_REQUIRED',
        message: 'appId and tenantId are required to operate a WhatsApp account',
      });
      return;
    }

    const bindings = await getActiveBindings(waAccountId);
    const allowed = bindings.some(
      (binding) => binding.app_id === scope.appId && binding.tenant_id === scope.tenantId
    );

    if (!allowed) {
      res.status(403).json({
        error: 'ACCOUNT_SCOPE_FORBIDDEN',
        message: 'The requested WhatsApp account is not bound to this appId and tenantId',
      });
      return;
    }

    next();
  };
}

export function getScope(req: Request): { appId: string; tenantId: string } | null {
  return scopeFromRequest(req);
}
