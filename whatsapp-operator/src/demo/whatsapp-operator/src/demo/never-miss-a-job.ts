import type { WASocket } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';

/**
 * "Never Miss a Job" demo auto-responder.
 *
 * A proof asset for the trades pitch: when a customer WhatsApps a trade
 * business after hours (or mid-job), they get an instant first reply that
 * captures the job, the area and the urgency, instead of silence.
 *
 * DELIBERATELY FAIL-CLOSED:
 *  - does nothing unless NMJ_DEMO_ENABLED=true, AND
 *  - replies ONLY to chats listed in NMJ_DEMO_ONLY_CHAT (comma-separated
 *    JIDs or raw phone numbers). An empty allowlist means NO chat ever gets
 *    an auto-reply - a misconfiguration can never spam the owner's contacts.
 *  - one reply per chat per cooldown window (default 5 minutes) so a chatty
 *    tester does not get a wall of repeats.
 *
 * Everything is env-driven so the demo can be switched off without a deploy
 * rollback.
 */

const DEFAULT_REPLY = [
  'Thanks for your message - you have been received.',
  '',
  'The team is on a job right now, but your enquiry is logged and someone will call you back shortly.',
  '',
  'To get you sorted faster, reply with:',
  '1) What job do you need done?',
  '2) Your area / suburb',
  '3) How urgent is it - today, or can it wait a day or two?',
].join('\n');

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

interface NmjDemoConfig {
  enabled: boolean;
  replyText: string;
  allowedJids: Set<string>;
  cooldownMs: number;
}

function readConfig(): NmjDemoConfig {
  const enabled = ['1', 'true', 'yes', 'on'].includes(
    (process.env.NMJ_DEMO_ENABLED ?? '').toLowerCase(),
  );
  const replyText = process.env.NMJ_DEMO_TEXT?.trim() || DEFAULT_REPLY;
  const allowedJids = new Set(
    (process.env.NMJ_DEMO_ONLY_CHAT ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(normalizeToJid),
  );
  const cooldownMs = Number(process.env.NMJ_DEMO_COOLDOWN_MS ?? DEFAULT_COOLDOWN_MS);
  return { enabled, replyText, allowedJids, cooldownMs };
}

function normalizeToJid(value: string): string {
  if (value.includes('@')) return value;
  const digits = value.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

const lastReplyAt = new Map<string, number>();

/**
 * Send the demo first-reply if this inbound chat qualifies.
 * Returns true when a reply was sent.
 */
export async function maybeSendNmjDemoReply(
  sock: WASocket,
  waAccountId: string,
  remoteJid: string | undefined | null,
  logger: Logger,
): Promise<boolean> {
  if (!remoteJid) return false;

  const cfg = readConfig();
  if (!cfg.enabled) return false;
  if (cfg.allowedJids.size === 0) return false; // fail-closed
  if (!cfg.allowedJids.has(remoteJid)) return false;

  const key = `${waAccountId}:${remoteJid}`;
  const now = Date.now();
  if (now - (lastReplyAt.get(key) ?? 0) < cfg.cooldownMs) return false;

  await sock.sendMessage(remoteJid, { text: cfg.replyText });
  lastReplyAt.set(key, now);
  logger.info({ waAccountId, remoteJid }, 'NMJ demo auto-reply sent');
  return true;
}
