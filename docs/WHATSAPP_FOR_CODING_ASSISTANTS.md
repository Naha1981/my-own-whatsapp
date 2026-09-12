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
│ CRM / orders       │                            │ QR + pairing code         │
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

## Business-owner pairing flow

The intended user journey now offers **two choices**. Both methods use the same Operator socket and both end in the same `connected` state.

```text
Business owner opens your app
        ↓
Clicks “Connect WhatsApp”
        ↓
App creates/loads a waAccountId
        ↓
App calls POST /accounts/:id/connect
        ↓
Dashboard offers:
   [ Scan QR ] OR [ Use phone number ]
        |
        +---- QR path ------------------------------+
        |                                             |
        | Operator generates QR                      |
        | App polls GET /accounts/:id/qr             |
        | Owner scans from own WhatsApp phone        |
        |                                             |
        +---- Pairing-code path ---------------------+
                  Owner enters WhatsApp number
                  App calls POST /accounts/:id/pairing-code
                  Operator returns short-lived code
                  Owner opens WhatsApp → Linked Devices
                  → Link a device → Link with phone number instead
                  → enters the code
                         |
                         v
                Operator receives pairing
                         |
                         v
              GET /accounts/:id/status
                         |
                         v
                     connected
```

The owner must complete the authorization from the **WhatsApp account they want to connect**. Typing a phone number into the website by itself does not authenticate the WhatsApp account.

## Tenant and account model

The Operator has a `waAccountId` for each connected WhatsApp identity.

Each application maps that account to its own:

- `appId`
- `tenantId`
- `webhookUrl`

The application is responsible for authorizing which authenticated user/admin is allowed to operate which tenant and `waAccountId`.

**Never trust a client-supplied tenant ID as authorization.** Resolve ownership from the application's authenticated user/session and database records first.

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

## Phone-number pairing-code rules

The Operator also supports WhatsApp Web phone-number pairing through `requestPairingCode(phoneNumber)`. The phone number must be supplied with its international country code; the Operator normalizes common formatting characters and validates an 8–15 digit result. citeturn203790search3turn203790search11

Use:

```http
POST /accounts/:id/pairing-code
X-API-Key: <OPERATOR_API_KEY>
Content-Type: application/json
```

```json
{
  "phoneNumber": "+27 82 123 4567"
}
```

Response includes:

```json
{
  "status": "pairing_code_ready",
  "pairingCode": "ABCD1234",
  "pairingCodeDisplay": "ABCD-1234",
  "expiresAt": "2026-09-12T07:01:00.000Z"
}
```

The dashboard should display the code and tell the owner to use their own WhatsApp application:

```text
WhatsApp → Linked Devices → Link a device
→ Link with phone number instead → enter the code
```

Implementation rules:

- never ask for a WhatsApp password;
- never treat the phone number alone as authentication;
- never store the temporary pairing code in browser localStorage;
- show its expiry time;
- allow only one active pairing code per account;
- after the code is entered on the phone, poll `/accounts/:id/status` until connected;
- treat `pairing_code_ready` as pending, not proof of success;
- use reset to start over when the owner wants to pair a different number or the session is broken.

The Operator also exposes:

```http
GET /accounts/:id/pairing-code
```

for recovering the currently active short-lived code. Responses are non-cacheable.

## Important diagnostic distinction

A QR or pairing code can be generated successfully while WhatsApp still refuses the device link. The meaningful diagnostic signal is the successful pairing/connection path, not merely receiving a code.

For troubleshooting, inspect the Operator logs for:

```text
WhatsApp QR generated
WhatsApp pairing code generated
WhatsApp pairing success received
WhatsApp connected
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

### Start the WhatsApp session

```http
POST /accounts/:id/connect
X-API-Key: <OPERATOR_API_KEY>
```

Then choose either the QR flow or the pairing-code flow above.

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

## Inbound message processing

The application's webhook handler should:

1. Verify the HMAC signature.
2. Resolve the tenant/account from trusted application-side binding data.
3. De-duplicate the message using a stable WhatsApp message ID before triggering business logic.
4. Apply application safety/opt-out rules.
5. Pass the message to the domain layer (CRM, AI assistant, orders, support inbox, etc.).
6. Persist the business result independently of the WhatsApp transport.
7. Reply through the transport abstraction rather than calling Baileys directly.

## Transport abstraction

Applications should hide the provider behind a small interface:

```ts
export interface WhatsAppTransport {
  connect(accountId: string): Promise<void>;
  requestPairingCode(accountId: string, phoneNumber: string): Promise<unknown>;
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
- `loggedOut` → clear credentials and require a new pairing;
- bad-session / status 500 → clear credentials and start a clean session;
- connection replaced elsewhere → do not create a reconnect loop;
- stale socket close → must never delete a newer live socket.

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
- [ ] User is offered both QR and phone-number pairing code when both are supported by the UI.
- [ ] QR polling is faster than QR refresh/expiry.
- [ ] QR is rendered without cropping or visual transformations.
- [ ] Expired QR is replaced instead of reused.
- [ ] Pairing codes are not persisted in browser storage.
- [ ] Connected state removes pairing UI.
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
- Expired pairing code.
- QR scanned but pairing not completed.
- Pairing code entered but pairing not completed.
- WhatsApp session replaced on another device.
- transient socket disconnect.
- logged-out session.
- bad session / status 500.
- webhook timeout.
- webhook 500 after retry.
- duplicate message delivery.
- unauthorized tenant attempting to use another tenant's account.

## Troubleshooting pairing

Follow this order and do not skip directly to code changes:

1. Confirm the deployed Operator commit is the expected commit.
2. Confirm the Operator is actually running.
3. For QR: confirm the QR is changing and is not being cached.
4. For QR: confirm the QR decodes programmatically as a valid Baileys pairing string.
5. Use the owner's real WhatsApp phone via Linked Devices.
6. For phone pairing: verify the entered number includes the country code and is the same WhatsApp account the owner is authorizing.
7. Search Operator logs for `WhatsApp pairing success received` and `WhatsApp connected`.
8. If pairing-success exists, debug persistence/status/dashboard reporting.
9. If pairing-success never appears across full QR/code attempts, inspect the close status and account/number trust before changing QR rendering code.
10. Try a different clean WhatsApp number if the evidence points to WhatsApp refusing the link.

## What not to put in an application

Do not add:

- Meta API tokens unless the user explicitly requests the official provider migration;
- Twilio credentials;
- Evolution API URLs or dependencies;
- Baileys session files on local disk;
- client-side copies of `OPERATOR_API_KEY` unless there is an explicit secure server-side proxy design;
- webhook secrets in browser code;
- pairing codes in long-lived browser storage;
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

Before changing WhatsApp code, inspect the current Operator implementation and this document. Reuse existing endpoints and abstractions. Make the smallest safe change. Test failure paths. Report exact evidence from typecheck/build/CI and deployment state. Never claim that a WhatsApp number is successfully linked until a real phone authorization has been observed and the Operator has recorded the successful pairing/connection path.
