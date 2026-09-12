# NahaLabs WhatsApp Operator — reusable integration contract

This repository provides a shared, self-hosted WhatsApp transport for NahaLabs applications.
Applications integrate with the Operator over HTTPS; they do not import or run Baileys.

## Runtime model

```text
Business owner's own WhatsApp phone
        |
        | choose QR scan OR phone-number pairing code
        v
Application dashboard
        |
        | HTTPS + X-API-Key
        v
NahaLabs WhatsApp Operator
        |
        +-- one Baileys socket per WhatsApp account
        +-- QR generation + expiry + connection lifecycle
        +-- phone-number pairing code flow
        +-- Postgres-backed credentials and Signal keys
        +-- signed inbound webhooks
        +-- outbound send API
        |
        v
     Postgres
```

A business owner connects the business WhatsApp number through the application's pairing UI.
They can either scan a QR code or use WhatsApp's phone-number pairing flow. The application never
asks for the owner's WhatsApp password or credentials.

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

## Reliable business-owner pairing flow

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

### 2. Start the WhatsApp connection

`POST /accounts/:id/connect`

The application then offers two user-visible choices:

```text
Connect your WhatsApp

[ Scan QR code ]

or

[ Use phone number ]
```

Both methods use the same underlying Operator session and end in the same `connected` state.

### 3A. QR-code pairing

After starting the session, poll `GET /accounts/:id/qr` about every 3 seconds while QR pairing is active.
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

On the **business owner's own WhatsApp phone**:

1. Open WhatsApp.
2. Open **Linked Devices**.
3. Choose **Link a device**.
4. Use the phone camera to scan the QR shown in the application's dashboard.

Keep the dashboard open and continue polling. When a new QR arrives, replace the displayed image with
that new QR immediately. Never keep displaying an expired QR.

### 3B. Phone-number pairing code

The alternative is to let the owner enter their WhatsApp phone number in the dashboard and receive a
short-lived pairing code. This is not password authentication: the owner still completes the link from
their own WhatsApp application.

Request a code with:

`POST /accounts/:id/pairing-code`

```json
{
  "phoneNumber": "+27 82 123 4567"
}
```

The Operator normalizes the number to digits and requires the international country code. Example response:

```json
{
  "waAccountId": "uuid",
  "status": "pairing_code_ready",
  "pairingCode": "ABCD1234",
  "pairingCodeDisplay": "ABCD-1234",
  "expiresAt": "2026-09-12T07:01:00.000Z",
  "instructions": [
    "Open WhatsApp on the business owner’s phone",
    "Open Linked Devices",
    "Choose Link a device",
    "Choose Link with phone number instead",
    "Enter the pairing code shown here"
  ]
}
```

The dashboard may call `GET /accounts/:id/pairing-code` to recover the currently active code during its
short lifetime. The response is explicitly non-cacheable.

Phone pairing rules:

- collect the business owner's WhatsApp number in international format;
- do not store the temporary pairing code in browser localStorage;
- show the expiry time and replace expired codes with a retry state;
- do not ask for a WhatsApp password or verification PIN;
- after the owner enters the code in WhatsApp, keep polling `/accounts/:id/status` until connected;
- treat `pairing_code_ready` as pending, not as proof of successful connection;
- a fresh pairing code is created only for the active unregistered socket/session;
- only one active pairing code is retained per account.

Baileys exposes `requestPairingCode(phoneNumber)` for Web-device pairing. The underlying pairing still
requires action from the owner's existing WhatsApp account. citeturn203790search3turn203790search11

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

When the status becomes `connected`, hide both pairing choices and show the business's connected
WhatsApp number. The Operator also logs the low-level `CB:iq,,pair-success` diagnostic when available.

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
The next connect call creates a fresh session and QR/pairing-code opportunity.

Use reset when an account is deliberately being re-paired or when the Operator reports a terminal
bad-session condition. Do not delete credentials for ordinary network reconnects.

## Connection lifecycle

The Operator follows the PDF recovery model:

- live WhatsApp Web revision is preferred when resolving the client version
- Baileys' version helper is the fallback
- QR generation is explicit, high-error-correction, and short-lived
- phone pairing codes are short-lived and held in memory only
- socket closes are logged before stale-socket checks
- stale sockets cannot delete a newer socket
- ordinary disconnects reconnect without deleting credentials
- `loggedOut` and bad-session/500 conditions purge credentials
- `connectionReplaced` does not trigger an automatic reconnect
- successful pairing is observable through the `pair-success` diagnostic event

A QR or pairing code can be presented successfully while WhatsApp still refuses the device link.
The `connected` status and pairing-success signal are therefore more useful than merely seeing a QR
or receiving a code. fileciteturn0file0L110-L119

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
  requestPairingCode(accountId: string, phoneNumber: string): Promise<unknown>;
  getStatus(accountId: string): Promise<unknown>;
  reset(accountId: string): Promise<void>;
  send(accountId: string, to: string, text: string): Promise<void>;
}
```

The current implementation is an unofficial WhatsApp Web/Linked Devices integration. It should be
used only with numbers/accounts where that use is permitted, and it should not be presented to a
customer as the official Meta API.
