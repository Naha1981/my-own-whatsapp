-- NahaLabs WhatsApp Presence Intelligence
-- Observes explicitly subscribed WhatsApp contacts for tenant-scoped analytics.

CREATE TABLE IF NOT EXISTS wa_presence_targets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  jid            TEXT NOT NULL,
  label          TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wa_account_id, app_id, tenant_id, jid)
);

CREATE TABLE IF NOT EXISTS wa_presence_observations (
  id             BIGSERIAL PRIMARY KEY,
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  jid            TEXT NOT NULL,
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_kind    TEXT NOT NULL,
  last_seen_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS wa_message_events (
  id             BIGSERIAL PRIMARY KEY,
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  jid            TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  UNIQUE (wa_account_id, app_id, tenant_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_presence_targets_scope
  ON wa_presence_targets(app_id, tenant_id, wa_account_id, is_active);

CREATE INDEX IF NOT EXISTS idx_presence_targets_lookup
  ON wa_presence_targets(wa_account_id, jid, is_active);

CREATE INDEX IF NOT EXISTS idx_presence_observations_report
  ON wa_presence_observations(app_id, tenant_id, wa_account_id, jid, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_events_report
  ON wa_message_events(app_id, tenant_id, wa_account_id, jid, occurred_at ASC);
