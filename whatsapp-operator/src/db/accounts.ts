import { pool } from './pool.js';

export interface WaAccount {
  id: string;
  label: string | null;
  phone_number: string | null;
  qr_code: string | null;
  is_connected: boolean;
  status: string;
}

export interface WaBinding {
  id: string;
  wa_account_id: string;
  app_id: string;
  tenant_id: string;
  webhook_url: string;
  is_active: boolean;
}

export async function createAccount(label?: string): Promise<WaAccount> {
  const { rows } = await pool.query<WaAccount>(
    `INSERT INTO wa_accounts (label) VALUES ($1) RETURNING *`,
    [label ?? null]
  );
  return rows[0];
}

export async function getAccount(id: string): Promise<WaAccount | null> {
  const { rows } = await pool.query<WaAccount>(`SELECT * FROM wa_accounts WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listConnectableAccounts(): Promise<WaAccount[]> {
  // Accounts that have saved credentials should be reconnected on boot.
  const { rows } = await pool.query<WaAccount>(
    `SELECT a.* FROM wa_accounts a
     WHERE EXISTS (SELECT 1 FROM wa_sessions s WHERE s.wa_account_id = a.id AND s.key = 'creds')
     AND a.status != 'logged_out'`
  );
  return rows;
}

export async function updateAccount(
  id: string,
  fields: Partial<Pick<WaAccount, 'qr_code' | 'is_connected' | 'phone_number' | 'status'>>
): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = keys.map((k) => (fields as any)[k]);
  await pool.query(
    `UPDATE wa_accounts SET ${setClause}, updated_at = now() WHERE id = $1`,
    [id, ...values]
  );
}

export async function createBinding(params: {
  waAccountId: string;
  appId: string;
  tenantId: string;
  webhookUrl: string;
}): Promise<WaBinding> {
  const { rows } = await pool.query<WaBinding>(
    `INSERT INTO wa_account_bindings (wa_account_id, app_id, tenant_id, webhook_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wa_account_id, app_id, tenant_id)
     DO UPDATE SET webhook_url = EXCLUDED.webhook_url, is_active = TRUE
     RETURNING *`,
    [params.waAccountId, params.appId, params.tenantId, params.webhookUrl]
  );
  return rows[0];
}

export async function getActiveBindings(waAccountId: string): Promise<WaBinding[]> {
  const { rows } = await pool.query<WaBinding>(
    `SELECT * FROM wa_account_bindings WHERE wa_account_id = $1 AND is_active = TRUE`,
    [waAccountId]
  );
  return rows;
}

export async function isAiEnabled(tenantId: string): Promise<boolean> {
  const { rows } = await pool.query<{ ai_enabled: boolean; manual_mode: boolean }>(
    `SELECT ai_enabled, manual_mode FROM wa_controls WHERE scope IN ('global', $1) ORDER BY scope = 'global' DESC`,
    [tenantId]
  );
  // Global switch off -> always off. Otherwise fall back to the tenant row (default: on, not manual).
  const global = rows.find((_r, i) => i === rows.length - 1); // last row after ordering is global if present
  if (global && global.ai_enabled === false) return false;
  const tenantRow = rows.find((r) => true) ?? { ai_enabled: true, manual_mode: false };
  return tenantRow.ai_enabled && !tenantRow.manual_mode;
}

export async function isBlocked(tenantId: string, phoneNumber: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM wa_blocklist WHERE tenant_id = $1 AND phone_number = $2`,
    [tenantId, phoneNumber]
  );
  return rows.length > 0;
}

export async function blockSender(tenantId: string, phoneNumber: string): Promise<void> {
  await pool.query(
    `INSERT INTO wa_blocklist (tenant_id, phone_number) VALUES ($1, $2)
     ON CONFLICT (tenant_id, phone_number) DO NOTHING`,
    [tenantId, phoneNumber]
  );
}
