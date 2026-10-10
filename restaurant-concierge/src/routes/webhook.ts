import { Router, raw } from 'express';
import pino from 'pino';
import { config } from '../config.js';
import { verifyWebhookSignature } from '../hmac.js';
import { resolveBranch, type BranchConfig } from '../branches.js';
import type { Store } from '../store.js';
import { notifyInbound } from '../notify.js';

const logger = pino({ level: config.logLevel });

type NormalizedInbound = {
  messageId: string | null;
  chatId: string | null;
  senderId: string | null;
  fromMe: boolean;
  pushName: string | null;
  messageType: string | null;
  text: string | null;
};

type OperatorEvent = {
  schemaVersion: number;
  waAccountId: string;
  appId: string;
  tenantId: string;
  event: string;
  data: NormalizedInbound;
  deliveredAt: string;
};

function isCustomerChat(chatId: string | null): boolean {
  if (!chatId) return false;
  if (chatId === 'status@broadcast') return false;
  if (chatId.endsWith('@g.us')) return false; // group chats are not concierge customers
  return chatId.endsWith('@s.whatsapp.net');
}

export function customerPhoneFrom(chatId: string): string {
  return `+${chatId.replace(/@s\.whatsapp\.net$/, '')}`;
}

/** Shared ingest path used by the real webhook AND the test simulator. */
export async function ingestInbound(
  store: Store,
  branch: BranchConfig,
  message: {
    waMessageId: string | null;
    customerPhone: string;
    pushName: string | null;
    text: string | null;
    messageType: string | null;
    payload: unknown;
  },
) {
  const stored = await store.storeInbound({
    branchId: branch.branchId,
    customerPhone: message.customerPhone,
    pushName: message.pushName,
    text: message.text,
    messageType: message.messageType,
    waMessageId: message.waMessageId,
    payload: message.payload,
  });
  if (!stored) return { duplicate: true as const };
  void notifyInbound(branch, stored).catch(() => undefined);
  return { duplicate: false as const, message: stored };
}

export function webhookRouter(branches: Map<string, BranchConfig>, store: Store): Router {
  const router = Router();

  router.post(
    '/operator',
    raw({ type: 'application/json' }),
    async (req, res) => {
      const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
      const signature = req.header('x-webhook-signature') ?? '';

      if (!verifyWebhookSignature(config.webhookSecret, rawBody, signature)) {
        res.status(401).json({ error: 'INVALID_SIGNATURE' });
        return;
      }

      let event: OperatorEvent;
      try {
        event = JSON.parse(rawBody) as OperatorEvent;
      } catch {
        res.status(400).json({ error: 'INVALID_JSON' });
        return;
      }

      if (event.event !== 'message') {
        res.json({ ok: true, ignored: `event:${event.event}` });
        return;
      }

      const data = event.data ?? ({} as NormalizedInbound);
      if (data.fromMe || !isCustomerChat(data.chatId)) {
        res.json({ ok: true, ignored: 'not-a-customer-dm' });
        return;
      }

      const branch = resolveBranch(branches, event.tenantId, event.waAccountId);
      if (!branch) {
        // Not one of ours (e.g. Flavourly traffic shares the Operator). Ack so
        // the Operator does not dead-letter it, but store nothing.
        res.json({ ok: true, ignored: 'unknown-branch' });
        return;
      }

      const result = await ingestInbound(store, branch, {
        waMessageId: data.messageId,
        customerPhone: customerPhoneFrom(data.chatId as string),
        pushName: data.pushName,
        text: data.text,
        messageType: data.messageType,
        payload: event,
      });

      if (result.duplicate) {
        res.json({ ok: true, duplicate: true });
        return;
      }

      logger.info({ branch: branch.branchId, customer: result.message.customer_phone, id: result.message.id }, 'Inbound customer message stored');
      res.json({ ok: true, duplicate: false, id: result.message.id });
    },
  );

  return router;
}
