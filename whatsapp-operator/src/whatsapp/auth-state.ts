import {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  initAuthCreds,
  BufferJSON,
} from '@whiskeysockets/baileys';
import { pool } from '../db/pool.js';

/**
 * Round-trips a value through Baileys' BufferJSON so Buffer/Uint8Array fields
 * survive being stored as JSONB in Postgres.
 */
function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}
function deserialize<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

async function getSessionValue(waAccountId: string, key: string): Promise<unknown | null> {
  const { rows } = await pool.query<{ value: unknown }>(
    `SELECT value FROM wa_sessions WHERE wa_account_id = $1 AND key = $2`,
    [waAccountId, key]
  );
  return rows[0]?.value ?? null;
}

async function setSessionValue(waAccountId: string, key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO wa_sessions (wa_account_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (wa_account_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [waAccountId, key, serialize(value)]
  );
}

/**
 * Postgres-backed replacement for Baileys' useMultiFileAuthState().
 * Stores the main credential blob in wa_sessions and the Signal protocol
 * key store (pre-keys, sessions, sender keys) in wa_signal_keys — so a
 * business's WhatsApp connection survives Operator restarts/redeploys
 * without re-scanning the QR code.
 */
export async function usePostgresAuthState(waAccountId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const storedCreds = await getSessionValue(waAccountId, 'creds');
  const creds: AuthenticationCreds = storedCreds ? deserialize(storedCreds) : initAuthCreds();

  const keys: AuthenticationState['keys'] = {
    get: async (type, ids) => {
      const result: { [id: string]: any } = {};
      if (ids.length === 0) return result;

      const { rows } = await pool.query<{ key_id: string; value: unknown }>(
        `SELECT key_id, value FROM wa_signal_keys
         WHERE wa_account_id = $1 AND key_type = $2 AND key_id = ANY($3)`,
        [waAccountId, type, ids]
      );

      for (const row of rows) {
        result[row.key_id] = row.value != null ? deserialize(row.value) : null;
      }
      return result;
    },

    set: async (data) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const forType = data[type] as Record<string, unknown> | undefined;
          if (!forType) continue;

          for (const id of Object.keys(forType)) {
            const value = forType[id];

            if (value === null || value === undefined) {
              await client.query(
                `DELETE FROM wa_signal_keys WHERE wa_account_id = $1 AND key_type = $2 AND key_id = $3`,
                [waAccountId, type, id]
              );
            } else {
              await client.query(
                `INSERT INTO wa_signal_keys (wa_account_id, key_type, key_id, value)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (wa_account_id, key_type, key_id)
                 DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
                [waAccountId, type, id, serialize(value)]
              );
            }
          }
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await setSessionValue(waAccountId, 'creds', creds);
    },
  };
}
