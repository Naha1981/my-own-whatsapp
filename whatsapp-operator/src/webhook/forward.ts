import pino from 'pino';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { getActiveBindings, type WaBinding } from '../db/accounts.js';
import { signPayload } from '../security/hmac.js';

const logger = pino({ level: config.logLevel });
const MAX_ATTEMPTS = 3;

/**
 * Deliver each inbound WhatsApp event to every active app/tenant binding.
 * Failed delivery is retried and then persisted to a durable dead-letter table.
 */
export async function forwardInboundMessage(waAccountId: string, message: unknown): Promise<void> {
  const bindings = await getActiveBindings(waAccountId);

  if (bindings.length === 0) {
    logger.warn({ waAccountId }, 'No active binding for this account — message received but dropped');
    return;
  }

  await Promise.all(
    bindings.map(async (binding) => {
      const payload = {
        waAccountId,
        appId: binding.app_id,
        tenantId: binding.tenant_id,
        message,
        deliveredAt: new Date().toISOString(),
      };
      await deliverWithRetry(waAccountId, binding, payload);
    })
  );
}

async function deliverWithRetry(
  waAccountId: string,
  binding: WaBinding,
  payload: Record<string, unknown>
): Promise<void> {
  const signature = signPayload(config.webhookSecret, payload);
  let lastError = 'unknown delivery failure';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(binding.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
      logger.warn(
        { webhookUrl: binding.webhook_url, status: response.status, attempt, waAccountId },
        'Webhook delivery rejected, retrying'
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        { webhookUrl: binding.webhook_url, attempt, waAccountId, err },
        'Webhook delivery error, retrying'
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  await pool.query(
    `INSERT INTO wa_webhook_dead_letters
      (wa_account_id, app_id, tenant_id, webhook_url, payload, last_error, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      waAccountId,
      binding.app_id,
      binding.tenant_id,
      binding.webhook_url,
      payload,
      lastError,
      MAX_ATTEMPTS,
    ]
  );

  logger.error(
    { webhookUrl: binding.webhook_url, waAccountId, tenantId: binding.tenant_id },
    `Webhook delivery failed after ${MAX_ATTEMPTS} attempts and was persisted to the dead-letter table`
  );
}
