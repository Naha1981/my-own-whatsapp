import pino from 'pino';
import { config } from './config.js';
import type { BranchConfig } from './branches.js';
import type { StoredMessage } from './db.js';

const logger = pino({ level: config.logLevel });

/**
 * Notify the owner/agent that a customer message needs a reply.
 *
 * "resend" sends one email per inbound message; a Gmail wake subscription on
 * the recipient mailbox is what wakes the AI agent within seconds. The inbox
 * polling API is the fallback, so a failed notification never loses a message.
 */
export async function notifyInbound(branch: BranchConfig, message: StoredMessage): Promise<void> {
  if (config.notifier !== 'resend') return;
  if (!config.resendApiKey || !config.notifyTo) {
    logger.warn({ branch: branch.branchId }, 'NOTIFIER=resend but RESEND_API_KEY or NOTIFY_TO missing — notification skipped');
    return;
  }

  const preview = (message.text ?? `[${message.message_type ?? 'non-text'}]`).slice(0, 500);
  const subject = `[${branch.displayName}] WhatsApp from ${message.push_name || message.customer_phone}`;
  const body = [
    `Branch: ${branch.displayName} (${branch.branchId})`,
    `Customer: ${message.push_name ?? ''} <${message.customer_phone}>`,
    `Message id: ${message.id}`,
    `At: ${message.created_at}`,
    '',
    preview,
    '',
    `Reply: POST ${config.publicBaseUrl || '<concierge-url>'}/v1/replies`,
    `{"branchId": "${branch.branchId}", "to": "${message.customer_phone}", "text": "..."}`,
  ].join('\n');

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.resendApiKey}` },
      body: JSON.stringify({ from: config.notifyFrom, to: [config.notifyTo], subject, text: body }),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, branch: branch.branchId }, 'Resend notification rejected');
    }
  } catch (err) {
    logger.warn({ err, branch: branch.branchId }, 'Resend notification failed — message stays pending for polling');
  }
}
