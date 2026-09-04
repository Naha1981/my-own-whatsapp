import pino from 'pino';
import { config } from '../config.js';
import { getActiveBindings } from '../db/accounts.js';
import { signPayload } from '../security/hmac.js';

const logger = pino({ level: config.logLevel });
const MAX_ATTEMPTS = 3;

/**
 * An inbound WhatsApp message arrived for waAccountId. Look up every app/tenant
 * bound to that account and deliver a signed webhook to each of them.
 * One WhatsApp number can legitimately fan out to more than one app.
 */
export async function forwardInboundMessage(waAccountId: string, message: unknown): Promise<void> {
  const bindings = await getActiveBindings(waAccountId);

  if (bindings.length === 0) {
    logger.warn({ waAccountId }, 'No active binding for this account — message received but dropped');
    return;
  }

  await Promise.all(
    bindings.map((binding) =>
      deliverWithRetry(binding.webhook_url, {
        waAccountId,
        appId: binding.app_id,
        tenantId: binding.tenant_id,
        message,
        deliveredAt: new Date().toISOString(),
      })
    )
  );
}

async function deliverWithRetry(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const signature = signPayload(config.webhookSecret, payload);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) return;
      logger.warn({ webhookUrl, status: response.status, attempt }, 'Webhook delivery rejected, retrying');
    } catch (err) {
      logger.warn({ webhookUrl, attempt, err }, 'Webhook delivery error, retrying');
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 1000)); // simple linear backoff
  }

  // TODO: write this to a wa_webhook_dead_letters table instead of only logging,
  // so nothing is silently lost. Left as a deliberate next step, not hidden.
  logger.error({ webhookUrl }, `Webhook delivery failed after ${MAX_ATTEMPTS} attempts — message dead-lettered`);
}
