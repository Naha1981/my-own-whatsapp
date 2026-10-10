import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

/**
 * Concierge tables are prefixed rc_ and created idempotently. The concierge
 * shares the Operator's Postgres but NEVER touches wa_* tables.
 */
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rc_messages (
      id             BIGSERIAL PRIMARY KEY,
      branch_id      TEXT NOT NULL,
      direction      TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      customer_phone TEXT NOT NULL,
      push_name      TEXT,
      text           TEXT,
      message_type   TEXT,
      wa_message_id  TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      payload        JSONB,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS rc_messages_wa_id_unique
      ON rc_messages (wa_message_id) WHERE wa_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS rc_messages_branch_status
      ON rc_messages (branch_id, status, created_at);
    CREATE INDEX IF NOT EXISTS rc_messages_convo
      ON rc_messages (branch_id, customer_phone, created_at);
  `);
}

export type StoredMessage = {
  id: number;
  branch_id: string;
  direction: 'in' | 'out';
  customer_phone: string;
  push_name: string | null;
  text: string | null;
  message_type: string | null;
  wa_message_id: string | null;
  status: string;
  payload: unknown;
  created_at: string;
};

/** Insert an inbound message. Returns null when the WhatsApp id was already stored (duplicate delivery). */
export async function storeInbound(message: {
  branchId: string;
  customerPhone: string;
  pushName: string | null;
  text: string | null;
  messageType: string | null;
  waMessageId: string | null;
  payload: unknown;
}): Promise<StoredMessage | null> {
  const { rows } = await pool.query<StoredMessage>(
    `INSERT INTO rc_messages (branch_id, direction, customer_phone, push_name, text, message_type, wa_message_id, status, payload)
     VALUES ($1, 'in', $2, $3, $4, $5, $6, 'pending', $7)
     ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [message.branchId, message.customerPhone, message.pushName, message.text, message.messageType, message.waMessageId, JSON.stringify(message.payload ?? null)],
  );
  return rows[0] ?? null;
}

export async function storeOutbound(message: {
  branchId: string;
  customerPhone: string;
  text: string;
  status: 'sent' | 'simulated' | 'failed';
  payload: unknown;
}): Promise<StoredMessage> {
  const { rows } = await pool.query<StoredMessage>(
    `INSERT INTO rc_messages (branch_id, direction, customer_phone, text, message_type, status, payload)
     VALUES ($1, 'out', $2, $3, 'text', $4, $5)
     RETURNING *`,
    [message.branchId, message.customerPhone, message.text, message.status, JSON.stringify(message.payload ?? null)],
  );
  return rows[0];
}

export async function listInbox(params: { branchId?: string; status?: string; limit: number }): Promise<StoredMessage[]> {
  const conditions: string[] = [`direction = 'in'`];
  const values: unknown[] = [];
  if (params.branchId) { values.push(params.branchId); conditions.push(`branch_id = $${values.length}`); }
  if (params.status) { values.push(params.status); conditions.push(`status = $${values.length}`); }
  values.push(params.limit);
  const { rows } = await pool.query<StoredMessage>(
    `SELECT * FROM rc_messages WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC LIMIT $${values.length}`,
    values,
  );
  return rows;
}

export async function listConversation(branchId: string, customerPhone: string, limit: number): Promise<StoredMessage[]> {
  const { rows } = await pool.query<StoredMessage>(
    `SELECT * FROM rc_messages WHERE branch_id = $1 AND customer_phone = $2 ORDER BY created_at ASC LIMIT $3`,
    [branchId, customerPhone, limit],
  );
  return rows;
}

export async function setMessageStatus(id: number, status: string): Promise<StoredMessage | null> {
  const { rows } = await pool.query<StoredMessage>(
    `UPDATE rc_messages SET status = $2 WHERE id = $1 RETURNING *`,
    [id, status],
  );
  return rows[0] ?? null;
}

/** Mark every pending inbound message from this customer on this branch as replied. */
export async function markConversationReplied(branchId: string, customerPhone: string): Promise<void> {
  await pool.query(
    `UPDATE rc_messages SET status = 'replied'
     WHERE branch_id = $1 AND customer_phone = $2 AND direction = 'in' AND status = 'pending'`,
    [branchId, customerPhone],
  );
}

export async function listOutbound(branchId: string, customerPhone: string | null, limit: number): Promise<StoredMessage[]> {
  if (customerPhone) {
    const { rows } = await pool.query<StoredMessage>(
      `SELECT * FROM rc_messages WHERE branch_id = $1 AND direction = 'out' AND customer_phone = $2 ORDER BY created_at ASC LIMIT $3`,
      [branchId, customerPhone, limit],
    );
    return rows;
  }
  const { rows } = await pool.query<StoredMessage>(
    `SELECT * FROM rc_messages WHERE branch_id = $1 AND direction = 'out' ORDER BY created_at ASC LIMIT $2`,
    [branchId, limit],
  );
  return rows;
}
