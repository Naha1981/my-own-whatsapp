# NahaLabs WhatsApp Operator

Self-hosted, multi-tenant, QR-based WhatsApp infrastructure for NahaLabs applications. It uses
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) and keeps the long-lived WhatsApp
Web socket in one persistent Node process. Your application (the "Brain") talks to this Operator over
HTTP; it does not import or run Baileys itself.

This is intended as a reusable bridge while an application is being validated. It does **not** replace
WhatsApp's official business platform or remove WhatsApp's terms, account restrictions, or anti-abuse
controls. Do not use it for spam, bulk unsolicited messaging, or other prohibited automation.

## Architecture

```text
Business owner phone
        │
        │ WhatsApp → Linked Devices → Link a device → Scan QR
        ▼
Brain app dashboard ──HTTP + OPERATOR_API_KEY──▶ WhatsApp Operator ──Baileys──▶ WhatsApp
       ▲                                             │
       └──────────── signed inbound webhook ◀────────┤
                                                     │
                                             shared PostgreSQL
```

The Operator owns one live socket per `waAccountId`. PostgreSQL stores credentials and Signal keys so
normal Operator restarts/redeploys do not require another QR scan. Run one Operator process unless you
add cross-instance socket ownership/locking.

## Business-owner QR pairing

The intended flow is simple:

1. Your application creates a WhatsApp account with `POST /accounts` and receives `waAccountId`.
2. Your application calls `POST /accounts/:id/connect`.
3. The dashboard polls `GET /accounts/:id/qr` every ~3 seconds.
4. When `status` is `qr_ready`, render the returned `qrCode` value directly as an image source. It is a
   PNG data URL generated at 512×512 pixels with a quiet zone and high error correction.
5. On the business owner's **own WhatsApp phone**, open **Linked Devices → Link a device** and scan the
   QR displayed in your application's dashboard.
6. On success, the Operator receives/logs the pairing-success event and the account changes to
   `connected`; the dashboard should immediately stop showing the QR and show the connected number.
7. The same business WhatsApp number can now receive messages through the Operator webhook and send
   replies through `POST /send`.

Do not screenshot, crop, recolor, or otherwise transform the QR before displaying it. Preserve the white
quiet zone around the code. The API sends `Cache-Control: no-store` so browsers/proxies should not reuse an
old one-time QR.

QRs are deliberately short-lived. The API returns `qrGeneratedAt` and `qrExpiresAt`; after expiry the
Operator reports `qr_expired` and returns `qrCode: null`. Keep polling so the next fresh QR is displayed.

## Environment

Required Operator variables:

```bash
DATABASE_URL=...
WEBHOOK_SECRET=...
OPERATOR_API_KEY=...
PORT=3001
LOG_LEVEL=info
NODE_ENV=production
```

Application-side variables are documented in the repository `.env.example`:

```bash
OPERATOR_URL=https://your-operator.example.com
OPERATOR_API_KEY=the-same-secret-as-the-operator
WEBHOOK_SECRET=the-same-secret-as-the-operator
NEXT_PUBLIC_APP_ID=your-app-slug
NEXT_PUBLIC_APP_URL=https://your-app.example.com
```

In production, account creation rejects localhost webhook targets; use a public HTTPS webhook URL.

## Database

Initialize or upgrade the Operator database with:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

The schema contains:

- `wa_accounts` — connected WhatsApp identities plus QR snapshot and QR expiry metadata.
- `wa_sessions` and `wa_signal_keys` — persisted Baileys authentication and Signal state.
- `wa_account_bindings` — app/tenant ownership plus inbound webhook destinations.
- `wa_controls` and `wa_blocklist` — application-level safety switches/opt-outs.
- `wa_webhook_dead_letters` — durable record of webhook deliveries that failed all retries.

## Development and production

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm start
```

Or use the provided Dockerfile / Render Blueprint. The socket must live in a persistent process, not in a
serverless or edge function.

## API

All routes except `/health` require either:

```text
X-API-Key: <OPERATOR_API_KEY>
```

or the backwards-compatible form:

```text
Authorization: Bearer <OPERATOR_API_KEY>
```

### Create an account

`POST /accounts`

```json
{
  "label": "Thabo's Salon",
  "appId": "flavourly",
  "tenantId": "tenant_123",
  "webhookUrl": "https://flavourly.example.com/api/webhooks/whatsapp"
}
```

Response:

```json
{ "waAccountId": "uuid", "status": "pending" }
```

### Connect / pair

`POST /accounts/:id/connect`

Then poll `GET /accounts/:id/qr` every ~3 seconds:

```json
{
  "status": "qr_ready",
  "isConnected": false,
  "qrCode": "data:image/png;base64,...",
  "qrGeneratedAt": "2026-09-12T07:00:00.000Z",
  "qrExpiresAt": "2026-09-12T07:00:20.000Z",
  "qrPollIntervalMs": 3000
}
```

Render `qrCode` exactly as an image source. The Operator generates a 512×512 PNG with high error correction
and an explicit quiet zone so the business owner's WhatsApp camera can reliably decode it from a screen.

When WhatsApp accepts the link, `GET /accounts/:id/status` returns:

```json
{
  "waAccountId": "uuid",
  "status": "connected",
  "isConnected": true,
  "phoneNumber": "27821234567"
}
```

The Operator resolves a live WhatsApp Web revision before each socket creation, falls back to Baileys'
version lookup when needed, and sets a 20-second QR timeout. Pairing is a WhatsApp Linked Devices flow:
the business owner links their own WhatsApp number; the Operator does not ask the application for the
owner's WhatsApp credentials or password.

### Reset a broken pairing/session

`POST /accounts/:id/reset`

This stops the live socket, clears all persisted Baileys credentials and Signal keys, clears the QR/phone
snapshot, and returns the account to `pending`. Connect again to obtain a fresh QR.

### Disconnect

`POST /accounts/:id/disconnect`

This logs the account out and clears persisted authentication so the next connection is a clean pair.

### Send

`POST /send`

```json
{ "waAccountId": "uuid", "to": "27821234567", "text": "Your order is confirmed." }
```

### Health

`GET /health`

```json
{ "status": "ok", "service": "nahalabs-whatsapp-operator", "timestamp": "..." }
```

## Reconnect and diagnostics

The close handler logs the disconnect status **before** any stale-socket guard. A stale socket is never
allowed to delete or replace the current account socket.

- Ordinary transient disconnects reconnect after a short backoff without purging credentials.
- `loggedOut` purges persisted auth and requires a fresh scan.
- `500` / bad-session closes purge persisted auth and restart clean.
- `connectionReplaced` is treated as terminal for the current process rather than causing a reconnect loop.
- The low-level `CB:iq,,pair-success` event is explicitly logged when received.

When troubleshooting QR pairing, inspect logs in this order:

1. Is the deployed commit the code you expect?
2. Is a current QR being generated and refreshed?
3. Does the QR endpoint report fresh `qrGeneratedAt` / `qrExpiresAt` values?
4. Does the log contain `WhatsApp pairing success received` after the real phone scan?
5. What `statusCode` and error message were logged on close?
6. Are `DATABASE_URL`, `WEBHOOK_SECRET`, and `OPERATOR_API_KEY` identical wherever the two services share them?
7. Only then investigate account/number trust or WhatsApp-side refusal.

A QR timing out with no pairing-success signal is not itself a QR-generation bug; the underlying failure
may be on WhatsApp's side.

## Webhooks

Inbound messages are delivered to the active binding's `webhookUrl` with:

```text
X-Webhook-Signature: <HMAC-SHA256 hex>
```

The HMAC uses `WEBHOOK_SECRET`. Failed deliveries receive three attempts with linear backoff; after
that the payload is persisted to `wa_webhook_dead_letters` for explicit recovery tooling.

## Security and scaling rules

- Keep `OPERATOR_API_KEY` and `WEBHOOK_SECRET` out of source control.
- Verify the webhook signature before trusting inbound data.
- Keep the Operator on one persistent instance unless socket ownership/locking is implemented.
- Do not expose unauthenticated account, QR, status, reset, or send endpoints.
- Add application-level authorization so a tenant cannot operate another tenant's `waAccountId`.
- Add rate limiting and audit logging before regulated/high-volume production use.
