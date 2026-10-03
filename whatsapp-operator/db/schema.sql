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

CREATE TABLE IF NOT EXISTS wa_tenant_credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  token_hash     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, tenant_id),
  UNIQUE (token_hash)
);

CREATE TABLE IF NOT EXISTS wa_account_bindings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  webhook_url    TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wa_account_id, app_id, tenant_id)
);

-- Safe migration: the webhook is optional during first-time WhatsApp setup.
ALTER TABLE wa_account_bindings ALTER COLUMN webhook_url DROP NOT NULL;

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
  webhook_url    TEXT,
  payload        JSONB NOT NULL,
  last_error     TEXT,
  attempts       INTEGER NOT NULL DEFAULT 3,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE wa_webhook_dead_letters ALTER COLUMN webhook_url DROP NOT NULL;

-- Remote MCP OAuth state. Tokens are stored only as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id                    TEXT PRIMARY KEY,
  client_name                  TEXT NOT NULL,
  redirect_uris                TEXT[] NOT NULL,
  client_secret_hash           TEXT,
  token_endpoint_auth_method   TEXT NOT NULL DEFAULT 'none',
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  scope           TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  access_token_hash   TEXT PRIMARY KEY,
  refresh_token_hash  TEXT UNIQUE NOT NULL,
  client_id           TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  app_id              TEXT NOT NULL,
  tenant_id           TEXT NOT NULL,
  scope               TEXT NOT NULL,
  access_expires_at   TIMESTAMPTZ NOT NULL,
  refresh_expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bindings_account ON wa_account_bindings(wa_account_id);
CREATE INDEX IF NOT EXISTS idx_bindings_app_tenant_active ON wa_account_bindings(app_id, tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_tenant_credentials_scope ON wa_tenant_credentials(app_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_bindings_app_tenant ON wa_account_bindings(app_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_dead_letters_account ON wa_webhook_dead_letters(wa_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_qr_expiry ON wa_accounts(qr_expires_at) WHERE qr_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_codes_expiry ON mcp_oauth_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_client ON mcp_oauth_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_refresh ON mcp_oauth_tokens(refresh_token_hash);

-- WhatsApp Presence Intelligence: only contacts explicitly monitored by a tenant are retained.
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
