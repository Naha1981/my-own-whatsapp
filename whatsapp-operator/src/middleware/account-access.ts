import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { getActiveBindings, getTenantScopeByTokenHash } from '../db/accounts.js';
import { hashTenantToken, TENANT_TOKEN_HEADER } from '../security/tenant-token.js';
import { hasValidApiKey } from './auth.js';

export interface TenantScope {
  appId: string;
  tenantId: string;
  authMode: 'tenant-token' | 'legacy';
}

export async function resolveTenantScope(req: Request): Promise<TenantScope | null> {
  const tenantToken = String(req.header(TENANT_TOKEN_HEADER) ?? '').trim();

  if (tenantToken) {
    const scope = await getTenantScopeByTokenHash(hashTenantToken(tenantToken));
    if (!scope) return null;
    return { ...scope, authMode: 'tenant-token' };
  }

  if (!config.allowLegacyTenantHeaders || !hasValidApiKey(req)) {
    return null;
  }

  const appId = String(req.header('x-app-id') ?? req.body?.appId ?? '').trim();
  const tenantId = String(req.header('x-tenant-id') ?? req.body?.tenantId ?? '').trim();
  if (!appId || !tenantId) return null;

  return { appId, tenantId, authMode: 'legacy' };
}

export async function requireTenantScope(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const scope = await resolveTenantScope(req);
    if (!scope) {
      res.status(401).json({
        error: 'TENANT_AUTH_REQUIRED',
        message: 'Provide a valid X-NahaLabs-Tenant-Token credential',
      });
      return;
    }

    if (scope.authMode === 'legacy') {
      res.setHeader('X-NahaLabs-Legacy-Auth', 'true');
      res.setHeader('X-NahaLabs-Migration-Warning', 'Migrate this integration to X-NahaLabs-Tenant-Token and remove the platform API key.');
    }

    (req as Request & { tenantScope?: TenantScope }).tenantScope = scope;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAccountAccess(getAccountId: (req: Request) => string | undefined) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const waAccountId = getAccountId(req);
      if (!waAccountId) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'waAccountId is required',
        });
        return;
      }

      const scope = await resolveTenantScope(req);
      if (!scope) {
        res.status(401).json({
          error: 'TENANT_AUTH_REQUIRED',
          message: 'Provide a valid X-NahaLabs-Tenant-Token credential',
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
          message: 'The requested WhatsApp account is not bound to this application tenant',
        });
        return;
      }

      if (scope.authMode === 'legacy') {
        res.setHeader('X-NahaLabs-Legacy-Auth', 'true');
        res.setHeader('X-NahaLabs-Migration-Warning', 'Migrate this integration to X-NahaLabs-Tenant-Token and remove the platform API key.');
      }

      (req as Request & { tenantScope?: TenantScope }).tenantScope = scope;
      next();
    } catch (err) {
      next(err);
    }
  };
}
