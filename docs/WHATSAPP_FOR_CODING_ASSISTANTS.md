# NahaLabs WhatsApp — Coding Assistant Integration Guide

## Purpose

This document is the implementation contract for any NahaLabs application that needs WhatsApp functionality.

The reusable transport is the self-hosted `whatsapp-operator/` service in this repository. Applications integrate with it over HTTPS and must keep business logic independent of Baileys.

This is the temporary transport strategy while applications are being validated. It is not the official Meta WhatsApp Business Platform and must not be described to customers as the official Meta API.

## The architecture

```text
                         HTTPS + X-API-Key
┌────────────────────┐  ───────────────────────▶  ┌──────────────────────────┐
│ NahaLabs app       │                            │ WhatsApp Operator        │
│                    │  ◀── signed webhooks ───── │                          │
│ dashboard / AI /   │                            │ one Baileys socket/account│
│ CRM / orders       │                            │ QR pairing                │
└────────────────────┘                            │ reconnect / reset        │
                                                  │ send / receive           │
                                                  └───────────┬──────────────┘
                                                              │
                                                              ▼
                                                     ┌─────────────────┐
                                                     │ PostgreSQL      │
                                                     │ credentials     │
                                                     │ Signal keys     │
                                                     │ accounts/binding│
                                                     │ dead letters    │
                                                     └─────────────────┘
```

### Hard rule

**The application must not import `@whiskeysockets/baileys` and must not create a WhatsApp socket itself.**

Only the Operator owns Baileys sockets. This prevents every application from becoming its own WhatsApp infrastructure service and makes the later move to Meta Cloud API much easier.

## What the coding assistant must do first

Before writing WhatsApp code in a new app:

1. Read this document.
2. Read `docs/WHATSAPP_OPERATOR_INTEGRATION.md`.
3. Inspect the application repository to determine its existing auth, tenant model, webhook handling, and deployment model.
4. Search for any existing WhatsApp provider before adding another integration.
5. Reuse the existing transport boundary instead of creating a provider-specific business abstraction deep inside the application.

Never add Evolution API, Twilio, Meta Cloud API, or another WhatsApp provider unless the user explicitly changes the provider decision.

## Application environment

The consuming app needs:

```bash
OPERATOR_URL=https://your-whatsapp-operator.example.com
OPERATOR_API_KEY=<same value as Operator>
WEBHOOK_SECRET=<same value as Operator>
APP_ID=your-app-slug
APP_URL=https://your-app.example.com
```

The Operator itself requires:

```bash
DATABASE_URL=...
WEBHOOK_SECRET=...
OPERATOR_API_KEY=...
PORT=3001
LOG_LEVEL=info
NODE_ENV=production
```

`OPERATOR_API_KEY` and `WEBHOOK_SECRET` must match byte-for-byte between the application and Operator.

Production webhook URLs must be public HTTPS endpoints. Do not configure `localhost` or `127.0.0.1` in production.

## Tenant and account model

The Operator has a `waAccountId` for each connected WhatsApp identity.

Each application maps that account to its own:

- `appId`
- `tenantId`
- `webhookUrl`

The application is responsible for authorizing which authenticated user/admin is allowed to operate which tenant and `waAccountId`.

**Never trust a client-supplied tenant ID as authorization.** Resolve ownership from the application's authenticated user/session and database records first.

## Business-owner pairing flow

The intended user journey is:

```text
Business owner opens your app
        ↓
Clicks “Connect WhatsApp”
        ↓
App creates/loads a waAccountId
        ↓
App calls POST /accounts/:id/connect
        ↓
Operator generates a fresh QR
        ↓
App polls GET /accounts/:id/qr every ~3 seconds
        ↓
App renders the QR without modification
        ↓
Business owner opens their OWN WhatsApp on their phone
        ↓
WhatsApp → Linked Devices → Link a device
        ↓
Owner scans the displayed QR
        ↓
Operator receives the pairing event
        ↓
GET /accounts/:id/status becomes connected
        ↓
Dashboard shows the owner's connected business number
```

The owner scans using the WhatsApp account they want to use for the business. The Operator does not need the owner's WhatsApp credentials or password.

## QR-code rules

### Backend rules

The Operator should:

- generate QR codes from the current Baileys pairing value;
- use explicit QR expiry/refresh behavior;
- generate a sufficiently large PNG with a quiet zone;
- use high error correction;
- prevent caching of one-time QR images;
- replace expired QR data rather than serving stale values;
- clear the QR after successful connection;
- log QR generation and pairing-success events;
- avoid treating “QR generated” as evidence that WhatsApp accepted the pairing.

### Frontend rules

The consuming application should:

- poll the QR/status endpoint every 2–5 seconds while pairing;
- render the returned QR at an adequate physical size on desktop/mobile;
- preserve the QR's white quiet zone;
- never crop the QR tightly;
- never blur, compress, recolor, overlay a logo on top of the code, or transform it with CSS filters;
- disable aggressive browser/image caching for the QR;
- stop showing the QR once `isConnected` becomes true;
- show a “QR expired / refresh” state instead of asking the owner to scan an old image;
- provide a reset/retry action for a failed pairing.

### Important diagnostic distinction

A QR can be perfectly valid and still fail to link. The meaningful diagnostic signal is the pairing-success event, not merely QR generation.

For troubleshooting, inspect the Operator logs for:

```text
WhatsApp QR generated
WhatsApp pairing success received
WhatsApp connection closed
```

## API usage

### Create a WhatsApp account

```http
POST /accounts
X-API-Key: <OPERATOR_API_KEY>
Content-Type: application/json
```

```json
{
  "label": "Acme Salon",
  "appId": "acme",
  "tenantId": "tenant_123",
  "webhookUrl": "https://acme.example.com/api/webhooks/whatsapp"
}
```

Response:

```json
{
  "waAccountId": "uuid",
  "status": "pending"
}
```

### Start pairing

```http
POST /accounts/:id/connect
X-API-Key: <OPERATOR_API_KEY>
```

Then poll:

```http
GET /accounts/:id/qr
X-API-Key: <OPERATOR_API_KEY>
Cache-Control: no-cache
```

Typical response:

```json
{
  "status": "qr_ready",
  "isConnected": false,
  "qrCode": "data:image/png;base64,...",
  "qrGeneratedAt": "2026-09-12T00:00:00.000Z",
  "qrExpiresAt": "2026-09-12T00:00:20.000Z"
}
```

Where supported, a direct non-cacheable QR image endpoint may also be used:

```http
GET /accounts/:id/qr.png
```

### Check connection status

```http
GET /accounts/:id/status
X-API-Key: <OPERATOR_API_KEY>
```

```json
{
  "waAccountId": "uuid",
  "status": "connected",
  "isConnected": true,
  "phoneNumber": "27821234567"
}
```

### Reset a pairing/session

```http
POST /accounts/:id/reset
X-API-Key: <OPERATOR_API_KEY>
```

Use this when:

- the owner deliberately wants to link a different WhatsApp number;
- the session is corrupted;
- the Operator reports a terminal bad-session condition;
- pairing must start from a clean state.

Reset deletes persisted Baileys credentials and Signal keys and returns the account to `pending`.

### Disconnect

```http
POST /accounts/:id/disconnect
X-API-Key: <OPERATOR_API_KEY>
```

This intentionally logs out and clears persisted auth so the next connection is a clean pairing.

### Send a message

```http
POST /send
X-API-Key: <OPERATOR_API_KEY>
Content-Type: application/json
```

```json
{
  "waAccountId": "uuid",
  "to": "27821234567",
  "text": "Your order is confirmed."
}
```

## Webhook contract

The Operator sends inbound WhatsApp messages to the binding's `webhookUrl`.

```http
POST /api/webhooks/whatsapp
Content-Type: application/json
X-Webhook-Signature: <hex HMAC-SHA256>
```

Payload shape:

```json
{
  "waAccountId": "uuid",
  "appId": "acme",
  "tenantId": "tenant_123",
  "message": { "...": "raw Baileys WAMessage object" },
  "deliveredAt": "2026-09-12T00:00:00.000Z"
}
```

The signature is HMAC-SHA256 using `WEBHOOK_SECRET` over the exact JSON payload.

The receiving application must verify the signature **before** processing the message.

Example:

```ts
import crypto from 'node:crypto';

function verifyWebhook(secret: string, rawBody: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Prefer the framework's raw request-body support when implementing signature verification. Do not verify a signature against a differently serialized/reformatted JSON object if the webhook contract is based on the original body bytes.

## Inbound message processing

The application's webhook handler should:

1. Verify the HMAC signature.
2. Resolve the tenant/account from trusted application-side binding data.
3. De-duplicate the message using a stable WhatsApp message ID before triggering business logic.
4. Apply application safety/opt-out rules.
5. Pass the message to the domain layer (CRM, AI assistant, orders, support inbox, etc.).
6. Persist the business result independently of the WhatsApp transport.
7. Reply through the transport abstraction rather than calling Baileys directly.

Do not put tenant authorization decisions inside raw webhook JSON claims alone.

## Transport abstraction

Applications should hide the provider behind a small interface:

```ts
export interface WhatsAppTransport {
  connect(accountId: string): Promise<void>;
  getStatus(accountId: string): Promise<unknown>;
  reset(accountId: string): Promise<void>;
  send(accountId: string, to: string, text: string): Promise<void>;
}
```

Business logic should depend on `WhatsAppTransport`, not on Baileys.

That is the migration seam for the future Meta Cloud API provider.

## Reconnect behavior

Coding assistants must not “fix” every disconnect by deleting credentials.

The Operator follows this model:

- ordinary transient disconnect → reconnect and keep credentials;
- `loggedOut` → clear credentials and require a new scan;
- bad-session / status 500 → clear credentials and start a clean session;
- connection replaced elsewhere → do not create a reconnect loop;
- stale socket close → must never delete a newer live socket.

This distinction is critical for a reusable platform.

## Version and browser rules

The Operator resolves a WhatsApp Web revision before socket creation and logs the chosen revision. The live WhatsApp Web revision is preferred, with the Baileys version helper as fallback.

Do not hard-code a guessed WhatsApp protocol revision in application code.

Do not add random browser fingerprints to “make it work”. Keep the Operator's configured browser identity consistent unless evidence shows a compatibility issue.

## Deployment rules

The Operator must run as a persistent Node process or equivalent long-lived container. Do not move Baileys into a serverless or edge function.

For the current architecture:

- one Operator process owns the account sockets;
- PostgreSQL is shared by the Operator and its persistence layer;
- scale vertically unless cross-instance socket ownership/locking is introduced;
- Render/Docker configuration must deploy the `whatsapp-operator` directory as the persistent service.

## Testing checklist for every WhatsApp-enabled app

### Before merging

- [ ] No direct Baileys import in the application.
- [ ] Operator URL and shared secrets are configured.
- [ ] Tenant authorization prevents cross-tenant `waAccountId` access.
- [ ] Connect flow creates or selects exactly one account identity.
- [ ] QR polling is faster than QR refresh/expiry.
- [ ] QR is rendered without cropping or visual transformations.
- [ ] Expired QR is replaced instead of reused.
- [ ] Connected state removes the QR UI.
- [ ] Webhook signature verification is tested.
- [ ] Duplicate inbound messages do not double-trigger business actions.
- [ ] Send failures are surfaced to the application.
- [ ] Reset starts a fresh pairing flow.

### Failure-path tests

Test at least:

- Operator unavailable.
- Wrong API key.
- Missing webhook secret.
- Invalid webhook signature.
- Expired QR.
- QR scanned but pairing not completed.
- WhatsApp session replaced on another device.
- transient socket disconnect.
- logged-out session.
- bad session / status 500.
- webhook timeout.
- webhook 500 after retry.
- duplicate message delivery.
- unauthorized tenant attempting to use another tenant's account.

## Troubleshooting QR pairing

Follow this order and do not skip directly to code changes:

1. Confirm the deployed Operator commit is the expected commit.
2. Confirm the Operator is actually running.
3. Confirm the QR is changing and is not being cached.
4. Confirm the QR decodes programmatically as a valid Baileys pairing string.
5. Scan using the owner's real WhatsApp phone via Linked Devices.
6. Search Operator logs for `WhatsApp pairing success received`.
7. If pairing-success exists, debug persistence/status/dashboard reporting.
8. If pairing-success never appears across full QR cycles, inspect the close status and account/number trust before changing QR rendering code.
9. Try a different clean WhatsApp number if the evidence points to WhatsApp refusing the link.

The QR itself should not be blamed merely because the phone did not connect.

## What not to put in an application

Do not add:

- Meta API tokens unless the user explicitly requests the official provider migration;
- Twilio credentials;
- Evolution API URLs or dependencies;
- Baileys session files on local disk;
- client-side copies of `OPERATOR_API_KEY` unless there is an explicit secure server-side proxy design;
- webhook secrets in browser code;
- long-lived QR values in localStorage;
- guessed WhatsApp protocol versions;
- provider-specific code in core business/domain modules.

## Migration to Meta later

The application should be designed so the future migration changes only the transport layer.

Current path:

```text
Application domain
      ↓
WhatsAppTransport
      ↓
NahaLabs self-hosted Operator / Baileys
```

Future path:

```text
Application domain
      ↓
WhatsAppTransport
      ↓
Meta Cloud API adapter
```

Do not build customer/order/CRM/AI logic around Baileys-specific message types if a normalized application message model can be used instead.

## Final rule for coding assistants

Before changing WhatsApp code, inspect the current Operator implementation and this document. Reuse existing endpoints and abstractions. Make the smallest safe change. Test failure paths. Report exact evidence from typecheck/build/CI and deployment state. Never claim that a WhatsApp number is successfully linked until a real phone scan has been observed and the Operator has recorded the successful pairing/connection path.
