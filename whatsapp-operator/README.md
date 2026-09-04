# NahaLabs WhatsApp Operator

Self-hosted, multi-tenant, QR-based WhatsApp infrastructure. No Meta Cloud API approval, no
Twilio, no Evolution API, no monthly bill until you actually have a paying customer.

Built on [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) (the "Linked
Devices" WebSocket protocol — the same one WhatsApp Web uses). Runs as **one persistent process**
that any number of your apps can share. See `../docs/whatsapp-architecture.md` for the full
architecture explanation.

## Deploy it once

You need: a small always-on Node.js host (Render, Fly.io, Railway, or your own Docker host — **not**
a serverless function, the socket must stay open 24/7) and a Postgres database.

```bash
cd whatsapp-operator
cp .env.example .env      # fill in DATABASE_URL, generate WEBHOOK_SECRET and OPERATOR_API_KEY
psql "$DATABASE_URL" -f db/schema.sql

npm install
npm run dev                # local dev
# or
npm run build && npm start # production
# or
docker build -t nahalabs-whatsapp-operator . && docker run --env-file .env -p 3001:3001 nahalabs-whatsapp-operator
```

Generate strong secrets:
```bash
openssl rand -hex 32   # for WEBHOOK_SECRET
openssl rand -hex 32   # for OPERATOR_API_KEY
```

## The business-owner QR flow

1. **Your app** (the "Brain") calls `POST /accounts` to create a WhatsApp account for that
   business and bind it to your app + tenant.
2. Your app calls `POST /accounts/:id/connect`, then polls `GET /accounts/:id/qr` every couple of
   seconds and shows the returned `qrCode` (a base64 PNG data URL) in the owner's dashboard.
3. Owner scans it once with WhatsApp → Linked Devices. `status` flips to `connected`.
4. They can now display/download that same number's QR (or a `wa.me/<number>` link) from their
   dashboard to share with their own customers.
5. Customer messages arrive at your app's `webhookUrl`, signed with `X-Webhook-Signature`
   (HMAC-SHA256 over the raw JSON body, using `WEBHOOK_SECRET`) — verify it before trusting the
   payload.
6. Your app replies by calling `POST /send`.

## API reference

All routes except `/health` require `Authorization: Bearer <OPERATOR_API_KEY>`.

### `POST /accounts`
Create a WhatsApp account and bind it to your app.
```json
// request
{ "label": "Thabo's Salon", "appId": "flavourly", "tenantId": "tenant_123", "webhookUrl": "https://flavourly.vercel.app/api/webhooks/whatsapp" }
// response 201
{ "waAccountId": "uuid", "status": "pending" }
```

### `POST /accounts/:id/connect`
Starts the WhatsApp socket and begins generating a QR code.
```json
{ "waAccountId": "uuid", "status": "connecting" }
```

### `GET /accounts/:id/qr`
Poll while connecting the device.
```json
{ "status": "qr_ready", "isConnected": false, "qrCode": "data:image/png;base64,..." }
```

### `GET /accounts/:id/status`
```json
{ "waAccountId": "uuid", "status": "connected", "isConnected": true, "phoneNumber": "27821234567" }
```

### `POST /accounts/:id/disconnect`
Logs the device out. Owner must re-scan a fresh QR code to reconnect.

### `POST /send`
```json
// request
{ "waAccountId": "uuid", "to": "27821234567", "text": "Your order is confirmed." }
// response
{ "ok": true }
```

### `GET /health`
No auth required. `{ "status": "ok", "service": "nahalabs-whatsapp-operator", "timestamp": "..." }`.
Point your keep-alive scheduler (cron-job.org, UptimeRobot) at this every 5–10 minutes on free-tier
hosts that sleep on idle.

## Inbound webhook payload (sent to `webhookUrl`)

```json
{
  "waAccountId": "uuid",
  "appId": "flavourly",
  "tenantId": "tenant_123",
  "message": { "...": "raw Baileys WAMessage object" },
  "deliveredAt": "2026-09-04T10:00:00.000Z"
}
```
Header: `X-Webhook-Signature: <hmac-sha256 hex>`. Verify with the same `WEBHOOK_SECRET`:

```ts
import crypto from 'node:crypto';

function verify(secret: string, rawBody: string, signature: string) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}
```

## One Operator, many apps

Give every app the same `OPERATOR_URL` and `OPERATOR_API_KEY`. Each app creates its own
`wa_account` per business (or reuses one), with its own `webhookUrl`. The Operator resolves each
inbound message to the right app via `wa_account_bindings` — see `db/schema.sql`.

## Operating notes

- **One Operator process** holds the in-memory socket map. Scale it vertically (bigger instance),
  not horizontally, unless you add cross-instance socket locking — running two instances against
  the same accounts will cause conflicting sessions.
- Session credentials live in Postgres (`wa_sessions`, `wa_signal_keys`), not on local disk, so a
  redeploy or restart does **not** require re-scanning the QR code.
- If a device is logged out from the phone (owner unlinks it in WhatsApp), the Operator will
  **not** auto-reconnect — `status` becomes `logged_out` and the owner must scan a fresh QR code.
- Webhook delivery retries 3 times with linear backoff; failures are logged. For production,
  extend `src/webhook/forward.ts` to write failures to a dead-letter table instead of only logging
  (flagged with a `TODO` in the code) — this repo intentionally ships the simplest correct version.
- `wa_controls` and `wa_blocklist` tables are provisioned for a global AI kill-switch, per-tenant
  manual mode, and STOP/UNSUBSCRIBE compliance — wire them into your app's business logic; the
  Operator only stores them, your app's webhook handler should check them before auto-replying.

## What this is not

This is a starting point, not a finished managed product. Before a regulated client (bank,
insurer, government) goes live on it: add structured audit logging of every message and admin
action, a dead-letter queue for failed webhook deliveries, rate limiting on `/send`, and a
documented recovery runbook — see `../docs/SECURITY_CHECKLIST.md` and
`../docs/ENGINEERING_CONSTITUTION.md`.
