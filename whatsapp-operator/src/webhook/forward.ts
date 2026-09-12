import pino from 'pino';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { getActiveBindings, type WaBinding } from '../db/accounts.js';
import { signPayload } from '../security/hmac.js';
import { normalizeInboundMessage } from './normalize.js';
import type { WAMessage } from '@whiskeysockets/baileys';

const logger = pino({ level: config.logLevel });
const MAX_ATTEMPTS = 3;

export async function forwardInboundMessage(waAccountId: string, message: unknown): Promise<void> {
  const normalized = normalizeInboundMessage(message as WAMessage);
  await forwardEvent(waAccountId, 'message', normalized);
}

/** Forward connection, call, receipt, reaction, presence, contact and group events through the same signed webhook. */
export async function forwardEvent(waAccountId: string, event: string, data: unknown): Promise<void> {
  const bindings = await getActiveBindings(waAccountId);

  if (bindings.length === 0) {
    logger.warn({ waAccountId, event }, 'No active binding for this account — event received but dropped');
    return;
  }

  await Promise.all(
    bindings.map(async (binding) => {
      const payload = {
        schemaVersion: 1,
        waAccountId,
        appId: binding.app_id,
        tenantId: binding.tenant_id,
        event,
        data,
        deliveredAt: new Date().toISOString(),
      };

      const webhookUrl = binding.webhook_url;
      if (!webhookUrl) {
        logger.info(
          { waAccountId, appId: binding.app_id, tenantId: binding.tenant_id, event },
          'Webhook not configured yet — event retained by account scope but not delivered'
        );
        return;
      }

      await deliverWithRetry(waAccountId, { ...binding, webhook_url: webhookUrl }, payload);
    })
  );
}

async function deliverWithRetry(
  waAccountId: string,
  binding: WaBinding & { webhook_url: string },
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
          'X-Webhook-Schema-Version': String(payload.schemaVersion ?? 1),
          'X-Webhook-Event': String(payload.event ?? 'unknown'),
          'X-WhatsApp-Account-Id': waAccountId,
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
