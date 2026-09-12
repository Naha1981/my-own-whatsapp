# NahaLabs WhatsApp Operator — reusable integration contract

This repository provides a shared, self-hosted WhatsApp transport for NahaLabs applications.
Applications integrate with the Operator over HTTPS; they do not import or run Baileys.

## Runtime model

```text
Application / tenant
        |
        | HTTPS + X-API-Key
        v
NahaLabs WhatsApp Operator
        |
        +-- one Baileys socket per WhatsApp account
        +-- QR pairing + connection lifecycle
        +-- Postgres-backed credentials and Signal keys
        +-- signed inbound webhooks
        +-- outbound send API
        |
        v
     Postgres
```

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

## API flow

### 1. Create an account

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

Then poll `GET /accounts/:id/qr` every 2–5 seconds while pairing.

```json
{
  "status": "qr_ready",
  "isConnected": false,
  "qrCode": "data:image/png;base64,..."
}
```

Render the returned data URL directly. The Operator refreshes the QR as required by WhatsApp.
Do not cache a QR beyond its short lifetime.

### 3. Confirm connection

`GET /accounts/:id/status`

```json
{
  "waAccountId": "uuid",
  "status": "connected",
  "isConnected": true,
  "phoneNumber": "27821234567"
}
```

### 4. Receive inbound messages

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

### 5. Send outbound messages

`POST /send`

```json
{
  "waAccountId": "uuid",
  "to": "27821234567",
  "text": "Your order is confirmed."
}
```

The Operator normalizes a plain phone number to the standard WhatsApp user JID.

### 6. Reset a broken or intentionally replaced session

`POST /accounts/:id/reset`

Reset deletes the persisted Baileys credentials and Signal keys and returns the account to
`pending`. The next connect call creates a fresh session and QR.

Use reset when an account is deliberately being re-paired or when the Operator reports a terminal
bad-session condition. Do not delete credentials for ordinary network reconnects.

## Connection lifecycle

The Operator follows this recovery model:

- live WhatsApp Web revision is preferred when resolving the client version
- Baileys' version helper is the fallback
- socket closes are logged before stale-socket checks
- stale sockets cannot delete a newer socket
- ordinary disconnects reconnect without deleting credentials
- `loggedOut` and bad-session/500 conditions purge credentials
- `connectionReplaced` does not trigger an automatic reconnect
- successful pairing is observable through the `pair-success` diagnostic event

This is deliberate. A QR can be perfectly valid while WhatsApp still refuses the device link.
The pairing-success signal is therefore more useful than merely seeing a QR generated.

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
