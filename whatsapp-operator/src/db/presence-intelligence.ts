import { type WAMessage } from '@whiskeysockets/baileys';
import { pool } from './pool.js';
import { normalizeInboundMessage } from '../webhook/normalize.js';

export interface PresenceTarget {
  id: string;
  waAccountId: string;
  appId: string;
  tenantId: string;
  jid: string;
  label: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PresenceReport {
  target: {
    jid: string;
    label: string | null;
    days: number;
    timezone: string;
  };
  summary: {
    observedDays: number;
    presenceObservations: number;
    activeObservations: number;
    replyMessages: number;
    measuredReplyPairs: number;
    medianResponseMinutes: number | null;
    p90ResponseMinutes: number | null;
    confidence: 'low' | 'medium' | 'high';
  };
  availability: Array<{
    day: string;
    hour: number;
    hourLabel: string;
    activeObservations: number;
    observedDays: number;
    repeatRate: number;
  }>;
  replyHours: Array<{
    day: string;
    hour: number;
    hourLabel: string;
    replies: number;
  }>;
  evidence: {
    firstObservationAt: string | null;
    lastObservationAt: string | null;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
  };
  narrative: string;
  caveats: string[];
}

type Direction = 'inbound' | 'outbound';

interface PresenceRow {
  observed_at: string;
  status_kind: string;
}

interface MessageRow {
  occurred_at: string;
  direction: Direction;
}

const ACTIVE_PRESENCE = new Set(['available', 'composing', 'recording']);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function normaliseJid(value: string): string {
  const input = value.trim();
  if (input.includes('@')) return input;
  const digits = input.replace(/\D/g, '');
  if (!/^\d{5,20}$/.test(digits)) throw new Error('jid/to must contain a valid WhatsApp phone number or JID');
  return `${digits}@s.whatsapp.net`;
}

function toIsoFromBaileysTimestamp(value: unknown): string | null {
  if (typeof value === 'bigint') {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const milliseconds = value > 100_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }

  return null;
}

function parseLocalParts(iso: string, timezone: string): { day: string; date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));

  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    day: value.weekday,
    date: `${value.year}-${value.month}-${value.day}`,
    hour: Number(value.hour),
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function confidenceFor(observationCount: number, observedDays: number, measuredReplyPairs: number): PresenceReport['summary']['confidence'] {
  if (observationCount >= 40 && observedDays >= 10 && measuredReplyPairs >= 10) return 'high';
  if (observationCount >= 15 && observedDays >= 5) return 'medium';
  return 'low';
}

function buildNarrative(report: Omit<PresenceReport, 'narrative' | 'caveats'>): string {
  const topAvailability = report.availability.slice(0, 3);
  const topReply = report.replyHours.slice(0, 2);

  const availabilityText = topAvailability.length
    ? topAvailability.map((item) => `${item.day} ${item.hourLabel}`).join(', ')
    : 'no recurring active period yet';

  const replyText = topReply.length
    ? topReply.map((item) => `${item.day} ${item.hourLabel}`).join(', ')
    : 'no repeat reply period yet';

  const responseText = report.summary.medianResponseMinutes === null
    ? 'There are not enough captured message pairs to estimate response time.'
    : `The median observed response time is ${round1(report.summary.medianResponseMinutes)} minutes across ${report.summary.measuredReplyPairs} measured reply pairs.`;

  return `This WhatsApp number shows recurring activity around ${availabilityText}. Reply activity is concentrated around ${replyText}. ${responseText} Evidence confidence is ${report.summary.confidence} based on ${report.summary.presenceObservations} presence observations across ${report.summary.observedDays} observed days.`;
}

export async function upsertPresenceTarget(params: {
  waAccountId: string;
  appId: string;
  tenantId: string;
  jid: string;
  label?: string | null;
}): Promise<PresenceTarget> {
  const jid = normaliseJid(params.jid);
  const { rows } = await pool.query<PresenceTarget>(
    `INSERT INTO wa_presence_targets (wa_account_id, app_id, tenant_id, jid, label, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     ON CONFLICT (wa_account_id, app_id, tenant_id, jid)
     DO UPDATE SET label = EXCLUDED.label, is_active = TRUE, updated_at = now()
     RETURNING
       id,
       wa_account_id AS "waAccountId",
       app_id AS "appId",
       tenant_id AS "tenantId",
       jid,
       label,
       is_active AS "isActive",
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [params.waAccountId, params.appId, params.tenantId, jid, params.label ?? null],
  );
  return rows[0];
}

export async function listPresenceTargets(appId: string, tenantId: string, waAccountId: string): Promise<PresenceTarget[]> {
  const { rows } = await pool.query<PresenceTarget>(
    `SELECT
       id,
       wa_account_id AS "waAccountId",
       app_id AS "appId",
       tenant_id AS "tenantId",
       jid,
       label,
       is_active AS "isActive",
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM wa_presence_targets
     WHERE app_id = $1 AND tenant_id = $2 AND wa_account_id = $3 AND is_active = TRUE
     ORDER BY updated_at DESC`,
    [appId, tenantId, waAccountId],
  );
  return rows;
}

export async function disablePresenceTarget(
  appId: string,
  tenantId: string,
  waAccountId: string,
  jid: string,
): Promise<void> {
  await pool.query(
    `UPDATE wa_presence_targets
        SET is_active = FALSE, updated_at = now()
      WHERE app_id = $1 AND tenant_id = $2 AND wa_account_id = $3 AND jid = $4`,
    [appId, tenantId, waAccountId, normaliseJid(jid)],
  );
}

async function targetScopesForJid(waAccountId: string, jid: string): Promise<Array<{ appId: string; tenantId: string }>> {
  const { rows } = await pool.query<{ appId: string; tenantId: string }>(
    `SELECT app_id AS "appId", tenant_id AS "tenantId"
       FROM wa_presence_targets
      WHERE wa_account_id = $1 AND jid = $2 AND is_active = TRUE`,
    [waAccountId, normaliseJid(jid)],
  );
  return rows;
}

export async function recordPresenceUpdate(waAccountId: string, data: unknown): Promise<void> {
  if (!data || typeof data !== 'object') return;

  const payload = data as {
    presences?: Record<string, { lastKnownPresence?: string; lastSeen?: unknown }>;
  };
  if (!payload.presences || typeof payload.presences !== 'object') return;

  for (const [jid, presence] of Object.entries(payload.presences)) {
    const scopes = await targetScopesForJid(waAccountId, jid);
    if (scopes.length === 0) continue;

    const kind = typeof presence?.lastKnownPresence === 'string'
      ? presence.lastKnownPresence
      : 'unknown';
    const lastSeenAt = toIsoFromBaileysTimestamp(presence?.lastSeen);

    await Promise.all(scopes.map((scope) =>
      pool.query(
        `INSERT INTO wa_presence_observations
          (wa_account_id, app_id, tenant_id, jid, observed_at, status_kind, last_seen_at)
         VALUES ($1, $2, $3, $4, now(), $5, $6)`,
        [waAccountId, scope.appId, scope.tenantId, normaliseJid(jid), kind, lastSeenAt],
      ),
    ));
  }
}

export async function recordMessageEvent(waAccountId: string, message: WAMessage): Promise<void> {
  if (!message?.message || !message.key?.remoteJid || message.key.remoteJid.endsWith('@g.us')) return;

  const jid = normaliseJid(message.key.remoteJid);
  const scopes = await targetScopesForJid(waAccountId, jid);
  if (scopes.length === 0) return;

  const normalized = normalizeInboundMessage(message);
  const occurredAt = toIsoFromBaileysTimestamp(normalized.timestamp) ?? new Date().toISOString();
  const direction: Direction = normalized.fromMe ? 'outbound' : 'inbound';
  const messageId = normalized.messageId ?? `${occurredAt}:${direction}`;

  await Promise.all(scopes.map((scope) =>
    pool.query(
      `INSERT INTO wa_message_events
        (wa_account_id, app_id, tenant_id, jid, message_id, occurred_at, direction)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (wa_account_id, app_id, tenant_id, message_id) DO NOTHING`,
      [waAccountId, scope.appId, scope.tenantId, jid, messageId, occurredAt, direction],
    ),
  ));
}

export async function getPresenceReport(params: {
  appId: string;
  tenantId: string;
  waAccountId: string;
  jid: string;
  days?: number;
  timezone?: string;
}): Promise<PresenceReport> {
  const jid = normaliseJid(params.jid);
  const days = Math.min(90, Math.max(1, Math.floor(params.days ?? 30)));
  const timezone = params.timezone?.trim() || 'Africa/Johannesburg';
  try {
    new Intl.DateTimeFormat('en-ZA', { timeZone: timezone });
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }

  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const [{ rows: targetRows }, { rows: presenceRows }, { rows: messageRows }] = await Promise.all([
    pool.query<{ label: string | null }>(
      `SELECT label
         FROM wa_presence_targets
        WHERE app_id = $1 AND tenant_id = $2 AND wa_account_id = $3 AND jid = $4
        ORDER BY is_active DESC, updated_at DESC
        LIMIT 1`,
      [params.appId, params.tenantId, params.waAccountId, jid],
    ),
    pool.query<PresenceRow>(
      `SELECT observed_at, status_kind
         FROM wa_presence_observations
        WHERE app_id = $1 AND tenant_id = $2 AND wa_account_id = $3 AND jid = $4
          AND observed_at >= $5
        ORDER BY observed_at ASC`,
      [params.appId, params.tenantId, params.waAccountId, jid, since],
    ),
    pool.query<MessageRow>(
      `SELECT occurred_at, direction
         FROM wa_message_events
        WHERE app_id = $1 AND tenant_id = $2 AND wa_account_id = $3 AND jid = $4
          AND occurred_at >= $5
        ORDER BY occurred_at ASC`,
      [params.appId, params.tenantId, params.waAccountId, jid, since],
    ),
  ]);

  const observedDates = new Set<string>();
  const availability = new Map<string, { day: string; hour: number; dates: Set<string>; count: number }>();
  for (const row of presenceRows) {
    const local = parseLocalParts(row.observed_at, timezone);
    observedDates.add(local.date);
    if (!ACTIVE_PRESENCE.has(row.status_kind)) continue;

    const key = `${local.day}:${local.hour}`;
    const entry = availability.get(key) ?? {
      day: local.day,
      hour: local.hour,
      dates: new Set<string>(),
      count: 0,
    };
    entry.count += 1;
    entry.dates.add(local.date);
    availability.set(key, entry);
  }

  const availabilityRows = Array.from(availability.values())
    .map((item) => ({
      day: item.day,
      hour: item.hour,
      hourLabel: `${String(item.hour).padStart(2, '0')}:00–${String((item.hour + 1) % 24).padStart(2, '0')}:00`,
      activeObservations: item.count,
      observedDays: item.dates.size,
      repeatRate: observedDates.size ? round1(item.dates.size / observedDates.size) : 0,
    }))
    .filter((item) => item.observedDays >= 2)
    .sort((a, b) => (
      (b.observedDays * 3 + b.activeObservations + b.repeatRate * 10)
      - (a.observedDays * 3 + a.activeObservations + a.repeatRate * 10)
    ))
    .slice(0, 12);

  const replyHours = new Map<string, { day: string; hour: number; replies: number }>();
  for (const row of messageRows) {
    if (row.direction !== 'inbound') continue;
    const local = parseLocalParts(row.occurred_at, timezone);
    const key = `${local.day}:${local.hour}`;
    const entry = replyHours.get(key) ?? { day: local.day, hour: local.hour, replies: 0 };
    entry.replies += 1;
    replyHours.set(key, entry);
  }

  const replyHourRows = Array.from(replyHours.values())
    .map((item) => ({
      ...item,
      hourLabel: `${String(item.hour).padStart(2, '0')}:00–${String((item.hour + 1) % 24).padStart(2, '0')}:00`,
    }))
    .sort((a, b) => b.replies - a.replies)
    .slice(0, 8);

  const responseMinutes: number[] = [];
  let pendingOutbound: MessageRow | null = null;
  for (const row of messageRows) {
    if (row.direction === 'outbound') {
      pendingOutbound = row;
      continue;
    }
    if (!pendingOutbound) continue;

    const delta = (new Date(row.occurred_at).getTime() - new Date(pendingOutbound.occurred_at).getTime()) / 60_000;
    if (delta >= 0 && delta <= 24 * 60) responseMinutes.push(delta);
    pendingOutbound = null;
  }

  const summary: PresenceReport['summary'] = {
    observedDays: observedDates.size,
    presenceObservations: presenceRows.length,
    activeObservations: presenceRows.filter((row) => ACTIVE_PRESENCE.has(row.status_kind)).length,
    replyMessages: messageRows.filter((row) => row.direction === 'inbound').length,
    measuredReplyPairs: responseMinutes.length,
    medianResponseMinutes: percentile(responseMinutes, 0.5),
    p90ResponseMinutes: percentile(responseMinutes, 0.9),
    confidence: confidenceFor(presenceRows.length, observedDates.size, responseMinutes.length),
  };

  const reportBase = {
    target: {
      jid,
      label: targetRows[0]?.label ?? null,
      days,
      timezone,
    },
    summary,
    availability: availabilityRows,
    replyHours: replyHourRows,
    evidence: {
      firstObservationAt: presenceRows[0]?.observed_at ?? null,
      lastObservationAt: presenceRows.at(-1)?.observed_at ?? null,
      firstMessageAt: messageRows[0]?.occurred_at ?? null,
      lastMessageAt: messageRows.at(-1)?.occurred_at ?? null,
    },
  };

  return {
    ...reportBase,
    narrative: buildNarrative(reportBase),
    caveats: [
      'The report reflects observed WhatsApp activity captured by the subscribed NahaLabs WhatsApp account; it is not the business\'s published opening hours.',
      'Presence visibility depends on WhatsApp privacy settings and whether the target has been successfully subscribed to for presence updates.',
      'Response-time metrics only use message pairs captured in this NahaLabs WhatsApp account and therefore should be treated as observed behaviour, not a service-level guarantee.',
    ],
  };
}
