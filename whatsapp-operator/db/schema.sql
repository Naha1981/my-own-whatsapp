-- NahaLabs WhatsApp Operator — Postgres schema
-- Run this against the Operator database. All statements are safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS wa_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label          TEXT,
  phone_number   TEXT,
  qr_code        TEXT,
  qr_generated_at TIMESTAMPTZ,
  qr_expires_at  TIMESTAMPTZ,
  is_connected   BOOLEAN NOT NULL DEFAULT FALSE,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe migration for databases created before QR expiry metadata existed.
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ;
ALTER TABLE wa_accounts ADD COLUMN IF NOT EXISTS qr_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS wa_sessions (
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  value          JSONB NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wa_account_id, key)
);

CREATE TABLE IF NOT EXISTS wa_signal_keys (
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  key_type       TEXT NOT NULL,
  key_id         TEXT NOT NULL,
  value          JSONB,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wa_account_id, key_type, key_id)
);

CREATE TABLE IF NOT EXISTS wa_account_bindings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  webhook_url    TEXT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wa_account_id, app_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS wa_controls (
  scope          TEXT PRIMARY KEY,
  ai_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  manual_mode    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_blocklist (
  tenant_id      TEXT NOT NULL,
  phone_number   TEXT NOT NULL,
  blocked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, phone_number)
);

CREATE TABLE IF NOT EXISTS wa_webhook_dead_letters (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  webhook_url    TEXT NOT NULL,
  payload        JSONB NOT NULL,
  last_error     TEXT,
  attempts       INTEGER NOT NULL DEFAULT 3,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bindings_account ON wa_account_bindings(wa_account_id);
CREATE INDEX IF NOT EXISTS idx_bindings_app_tenant ON wa_account_bindings(app_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_dead_letters_account ON wa_webhook_dead_letters(wa_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_qr_expiry ON wa_accounts(qr_expires_at) WHERE qr_expires_at IS NOT NULL;
