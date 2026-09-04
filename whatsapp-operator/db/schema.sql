-- NahaLabs WhatsApp Operator — Postgres schema
-- Run this once against the Operator's own database.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- One row per connected WhatsApp number ("account").
CREATE TABLE IF NOT EXISTS wa_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label          TEXT,                       -- human-readable, e.g. "Thabo's Salon"
  phone_number   TEXT,                       -- filled in once connected
  qr_code        TEXT,                       -- current QR (data URL), null once connected
  is_connected   BOOLEAN NOT NULL DEFAULT FALSE,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | qr_ready | connected | disconnected | logged_out
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Baileys credential blob — one row per (account, key). key='creds' holds the main
-- AuthenticationCreds object. Stored via Baileys' own BufferJSON serialization so
-- Buffers survive the round trip through JSON/JSONB.
CREATE TABLE IF NOT EXISTS wa_sessions (
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  value          JSONB NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wa_account_id, key)
);

-- Baileys Signal protocol key store (pre-keys, sessions, sender keys, etc).
-- Matches the SignalKeyStore contract: keyed by (type, id).
CREATE TABLE IF NOT EXISTS wa_signal_keys (
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  key_type       TEXT NOT NULL,
  key_id         TEXT NOT NULL,
  value          JSONB,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wa_account_id, key_type, key_id)
);

-- Which app/tenant owns which WhatsApp account, and where to forward inbound messages.
-- One wa_account can fan out to more than one app if you ever need that.
CREATE TABLE IF NOT EXISTS wa_account_bindings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL,              -- e.g. 'flavourly', 'cargoiq'
  tenant_id      TEXT NOT NULL,              -- the app's own tenant/business id
  webhook_url    TEXT NOT NULL,              -- e.g. https://flavourly.vercel.app/api/webhooks/whatsapp
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wa_account_id, app_id, tenant_id)
);

-- Global + per-tenant safety switches.
CREATE TABLE IF NOT EXISTS wa_controls (
  scope          TEXT PRIMARY KEY,           -- 'global' or a tenant_id
  ai_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  manual_mode    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Senders who have opted out (STOP / UNSUBSCRIBE), scoped per tenant.
CREATE TABLE IF NOT EXISTS wa_blocklist (
  tenant_id      TEXT NOT NULL,
  phone_number   TEXT NOT NULL,
  blocked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_bindings_account ON wa_account_bindings(wa_account_id);
CREATE INDEX IF NOT EXISTS idx_bindings_app_tenant ON wa_account_bindings(app_id, tenant_id);
