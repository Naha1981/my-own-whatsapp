import { Router } from 'express';
import type { Request, Response } from 'express';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { requireApiKey } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';

/**
 * Internal per-tenant secret store (e.g. a client's own Gemini API key).
 *
 * Platform-key only: these routes are for NahaLabs product backends, never
 * for browsers or tenant-token callers. Values are encrypted with pgcrypto
 * pgp_sym_encrypt under TENANT_SECRETS_KEY before they touch the database.
 * Plaintext is never logged.
 */
export const tenantSecretsRouter = Router();

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,60}$/;

function scopeFrom(req: Request, res: Response): { appId: string; tenantId: string; name: string } | null {
  const appId = String(req.params.appId ?? '').trim();
  const tenantId = String(req.params.tenantId ?? '').trim();
  const name = String(req.params.name ?? '').trim();
  if (!appId || !tenantId || !NAME_PATTERN.test(name)) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'appId, tenantId and a lowercase secret name are required' });
    return null;
  }
  return { appId, tenantId, name };
}

function secretsReady(res: Response): boolean {
  if (!config.tenantSecretsKey) {
    res.status(503).json({ error: 'SECRETS_NOT_CONFIGURED', message: 'TENANT_SECRETS_KEY is not set on the Operator' });
    return false;
  }
  return true;
}

/** Store or replace a secret. Body: { "value": "..." }. Never returns the value. */
tenantSecretsRouter.put('/:appId/:tenantId/:name', requireApiKey, asyncHandler(async (req, res) => {
  if (!secretsReady(res)) return;
  const scope = scopeFrom(req, res);
  if (!scope) return;
  const value = String(req.body?.value ?? '');
  if (!value || value.length > 4096) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'value is required (max 4096 chars)' });
    return;
  }
  await pool.query(
    `INSERT INTO wa_tenant_secrets (app_id, tenant_id, name, value_encrypted)
     VALUES ($1, $2, $3, pgp_sym_encrypt($4, $5))
     ON CONFLICT (app_id, tenant_id, name)
     DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = now()`,
    [scope.appId, scope.tenantId, scope.name, value, config.tenantSecretsKey],
  );
  res.json({ appId: scope.appId, tenantId: scope.tenantId, name: scope.name, stored: true });
}));

/** Read a secret back. Internal callers only. */
tenantSecretsRouter.get('/:appId/:tenantId/:name', requireApiKey, asyncHandler(async (req, res) => {
  if (!secretsReady(res)) return;
  const scope = scopeFrom(req, res);
  if (!scope) return;
  const result = await pool.query(
    `SELECT pgp_sym_decrypt(value_encrypted, $4) AS value, updated_at
     FROM wa_tenant_secrets WHERE app_id = $1 AND tenant_id = $2 AND name = $3`,
    [scope.appId, scope.tenantId, scope.name, config.tenantSecretsKey],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ appId: scope.appId, tenantId: scope.tenantId, name: scope.name, value: result.rows[0].value, updatedAt: result.rows[0].updated_at });
}));

/** Delete a secret (e.g. client removes their key). */
tenantSecretsRouter.delete('/:appId/:tenantId/:name', requireApiKey, asyncHandler(async (req, res) => {
  if (!secretsReady(res)) return;
  const scope = scopeFrom(req, res);
  if (!scope) return;
  const result = await pool.query(
    `DELETE FROM wa_tenant_secrets WHERE app_id = $1 AND tenant_id = $2 AND name = $3`,
    [scope.appId, scope.tenantId, scope.name],
  );
  res.json({ appId: scope.appId, tenantId: scope.tenantId, name: scope.name, deleted: (result.rowCount ?? 0) > 0 });
}));
