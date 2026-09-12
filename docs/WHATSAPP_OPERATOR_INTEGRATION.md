# NahaLabs WhatsApp Operator — reusable integration contract

This repository provides a shared, self-hosted WhatsApp transport for NahaLabs applications.
Applications integrate with the Operator over HTTPS; they do not import or run Baileys.

## Runtime model

```text
Business owner's own WhatsApp phone
        |
        | WhatsApp → Linked Devices → Link a device → Scan QR
        v
Application dashboard
        |
        | HTTPS + X-API-Key
        v
NahaLabs WhatsApp Operator
        |
        +-- one Baileys socket per WhatsApp account
        +-- QR generation + expiry + connection lifecycle
        +-- Postgres-backed credentials and Signal keys
        +-- signed inbound webhooks
        +-- outbound send API
        |
        v
     Postgres
```

A business owner connects the business WhatsApp number by scanning the QR displayed by your application.
The application never asks for the owner's WhatsApp password or credentials.

Run one Operator process for the accounts it owns. Do not horizontally scale multiple Operator
instances against the same account set unless cross-instance ownership/locking is introduced.

## Environment

Operator:

- `DATABASE_URL`
- `WEBHOOK_SECRET`
- `OPERATOR_API_KEY`
- `PORT` (default `3001`)
- `LOG_LEVEL` (default `info`)

Every application consuming the Operator needs:

- `OPERATOR_URL`
- `OPERATOR_API_KEY` — byte-for-byte identical to the Operator value
- `WEBHOOK_SECRET` — byte-for-byte identical to the Operator value
- `APP_ID`
- `APP_URL`

Production webhook URLs must be public HTTPS endpoints. `localhost` and `127.0.0.1` are rejected.

## Reliable business-owner QR flow

### 1. Create the business WhatsApp account

`POST /accounts`

```json
{
  "label": "Acme Salon",
  "appId": "acme",
  "tenantId": "tenant_123",
  "webhookUrl": "https://app.example.com/api/webhooks/whatsapp"
}
```

Response:

```json
{
  "waAccountId": "uuid",
  "status": "pending"
}
```

### 2. Start pairing

`POST /accounts/:id/connect`

Then poll `GET /accounts/:id/qr` about every 3 seconds while pairing.
The API explicitly disables caching because each QR is a short-lived one-time pairing value.

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

The QR is generated as a 512×512 PNG with a white quiet zone and high error correction. Render the
`qrCode` data URL directly as an image; do not crop it, recolor it, compress it, or place content over it.
The optional direct image route `GET /accounts/:id/qr.png` is suitable when the frontend prefers an
ordinary image URL instead of a data URL.

### 3. Scan from the business owner's phone

On the **business owner's own WhatsApp phone**:

1. Open WhatsApp.
2. Open **Linked Devices**.
3. Choose **Link a device**.
4. Use the phone camera to scan the QR shown in the application's dashboard.

Keep the dashboard open and continue polling. When a new QR arrives, replace the displayed image with
that new QR immediately. Never keep displaying an expired QR.

### 4. Confirm connection

`GET /accounts/:id/status`

```json
{
  "waAccountId": "uuid",
  "status": "connected",
  "isConnected": true,
  "phoneNumber": "27821234567"
}
```

When the status becomes `connected`, hide the QR and show the business's connected WhatsApp number.
The Operator also logs the low-level `CB:iq,,pair-success` diagnostic when available.

## QR reliability rules

The PDF's playbook is explicit that the QR should be programmatically decodable before blaming QR
rendering. This implementation therefore uses a real QR encoder, a 512px PNG, high error correction,
and a preserved quiet zone rather than a terminal-only or text representation. fileciteturn0file0L128-L135

The dashboard should poll substantially faster than the QR refresh cadence. The reference recommends
roughly 2–3 seconds; this API advertises 3000ms. fileciteturn0file0L185-L188

If the QR expires, the API returns `status: "qr_expired"` and `qrCode: null`. Keep polling for the next
fresh QR. Do not retry by reconnecting the same account repeatedly from the frontend.

## 5. Receive inbound messages

The Operator POSTs to the configured `webhookUrl` with:

```json
{
  "waAccountId": "uuid",
  "appId": "acme",
  "tenantId": "tenant_123",
  "message": { "...": "raw Baileys WAMessage object" },
  "deliveredAt": "2026-09-12T00:00:00.000Z"
}
```

Header:

```text
X-Webhook-Signature: <sha256 hex>
```

The signature is HMAC-SHA256 of the exact JSON payload using `WEBHOOK_SECRET`.
Verify it before processing the message.

### 6. Send outbound messages

`POST /send`

```json
{
  "waAccountId": "uuid",
  "to": "27821234567",
  "text": "Your order is confirmed."
}
```

### 7. Reset a broken or intentionally replaced session

`POST /accounts/:id/reset`

Reset deletes the persisted Baileys credentials and Signal keys and returns the account to `pending`.
The next connect call creates a fresh session and QR.

Use reset when an account is deliberately being re-paired or when the Operator reports a terminal
bad-session condition. Do not delete credentials for ordinary network reconnects.

## Connection lifecycle

The Operator follows the PDF recovery model:

- live WhatsApp Web revision is preferred when resolving the client version
- Baileys' version helper is the fallback
- QR generation is explicit, high-error-correction, and short-lived
- socket closes are logged before stale-socket checks
- stale sockets cannot delete a newer socket
- ordinary disconnects reconnect without deleting credentials
- `loggedOut` and bad-session/500 conditions purge credentials
- `connectionReplaced` does not trigger an automatic reconnect
- successful pairing is observable through the `pair-success` diagnostic event

A QR can be perfectly valid while WhatsApp still refuses the device link. The pairing-success signal is
therefore more useful than merely seeing a QR generated. fileciteturn0file0L110-L119

## Webhook reliability

Failed webhook deliveries are retried three times with linear backoff. After the final failure,
the payload is persisted in the dead-letter table for later recovery.

## Security boundary

All account and send routes require `X-API-Key` or `Authorization: Bearer` using the shared
`OPERATOR_API_KEY`. The comparison is constant-time.

The Operator signs outbound webhooks with `WEBHOOK_SECRET`. The consuming application must verify
the signature before trusting the message.

## Using this before Meta Cloud API

This Operator is intentionally a transport boundary. Applications should keep their business logic
independent of Baileys so the eventual migration to official Meta WhatsApp Cloud API can replace the
transport without rewriting tenant, conversation, AI, order, or CRM logic.

Recommended application boundary:

```ts
interface WhatsAppTransport {
  connect(accountId: string): Promise<void>;
  getStatus(accountId: string): Promise<unknown>;
  reset(accountId: string): Promise<void>;
  send(accountId: string, to: string, text: string): Promise<void>;
}
```

The current implementation is an unofficial WhatsApp Web/Linked Devices integration. It should be
used only with numbers/accounts where that use is permitted, and it should not be presented to a
customer as the official Meta API.
