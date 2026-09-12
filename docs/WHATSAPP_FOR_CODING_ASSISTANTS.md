# NahaLabs WhatsApp System — AI Coding Assistant Integration Manual

## 1. Purpose

This document is the implementation contract for any AI coding assistant, developer, or automation system integrating a NahaLabs application with the reusable NahaLabs WhatsApp Operator.

The Operator is the central WhatsApp transport service in this repository. NahaLabs applications call it over HTTPS. The Operator owns the WhatsApp Web/Baileys connection, QR/pairing flow, session persistence, outbound messaging, inbound event delivery, and low-level WhatsApp operations.

**Core rule:** consuming applications must not create WhatsApp sockets or import Baileys. They integrate with the Operator API.

This architecture is intentionally provider-independent at the application/business layer so a future Meta Cloud API adapter can replace the current transport without rewriting CRM, support, ordering, booking, AI, or other domain logic.

> This is a self-hosted WhatsApp Web transport. It is not the official Meta WhatsApp Business Platform. Do not describe it to customers as the Meta API, and do not use it for spam, bulk unsolicited messaging, or prohibited automation.

## 2. Current central Operator

Current Render service:

```text
https://my-own-whatsapp-2z5h.onrender.com
```

Operator console:

```text
https://my-own-whatsapp-2z5h.onrender.com/operator-console
```

Health endpoint:

```text
GET /health
```

The current deployment is configured as a persistent Docker web service in Frankfurt. The service uses PostgreSQL for account, session, Signal-key, binding, control, blocklist, and webhook dead-letter persistence.

Do not create another WhatsApp Operator for a new NahaLabs application unless there is a deliberate architectural reason to isolate infrastructure.

## 3. Architecture

```text
┌──────────────────────────────┐
│ NahaLabs application         │
│                              │
│ CRM / Support / Orders / AI  │
│ Booking / Notifications      │
│ Admin dashboard              │
└──────────────┬───────────────┘
               │ HTTPS
               │ X-API-Key + tenant scope
               ▼
┌────────────────────────────────────────┐
│ NahaLabs WhatsApp Operator             │
│                                        │
│ accounts / pairing / send / messages   │
│ media / calls / reconnect / webhooks   │
│                                        │
│ one live socket per waAccountId         │
└─────────────────────┬──────────────────┘
                      │
                      ▼
              WhatsApp / Baileys
                      │
                      ▼
              PostgreSQL persistence

Inbound events travel in the opposite direction:

WhatsApp → Operator → signed webhook → NahaLabs application
```

### Ownership boundaries

**Operator owns:**

- WhatsApp socket lifecycle.
- QR generation and refresh.
- Phone-number pairing codes.
- WhatsApp authentication/session state.
- Reconnection and connection status.
- Sending WhatsApp messages.
- WhatsApp message actions exposed by the API.
- Media download from inbound WhatsApp messages.
- Signed webhook delivery.

**Application owns:**

- User authentication.
- Admin permissions.
- Tenant authorization.
- Customer/lead/order/booking/support data.
- AI decisions and business rules.
- Notification policy.
- Message templates.
- Scheduling/business events.
- Idempotency for business actions.
- Audit records.
- Which WhatsApp account belongs to which tenant.

## 4. What an AI coding assistant must do first

Before making WhatsApp changes in any NahaLabs app:

1. Read this document.
2. Read `docs/WHATSAPP_OPERATOR_INTEGRATION.md` in this repository.
3. Inspect the target application repository's authentication, tenant model, database, webhook system, and deployment configuration.
4. Search for an existing WhatsApp integration before creating new code.
5. Reuse the application's existing domain abstractions where possible.
6. Add WhatsApp only at the transport/integration boundary.
7. Run typecheck/build/tests before claiming the change works.

Never silently add a second WhatsApp provider.

Never import `@whiskeysockets/baileys` into a consuming application.

Never hard-code the Operator API key into browser JavaScript.

## 5. Multi-app and multi-tenant model

The same central Operator can serve many NahaLabs applications.

Each WhatsApp identity is represented by:

```text
waAccountId
```

A binding associates that WhatsApp identity with:

```text
appId
 tenantId
 webhookUrl
```

A single application can therefore have many tenants, and each tenant can have one or more WhatsApp identities depending on the application's business rules.

### Recommended mapping

```text
NahaLabs App A
  tenant_001 → waAccountId_A
  tenant_002 → waAccountId_B

NahaLabs App B
  tenant_001 → waAccountId_C
```

The same tenant name across two applications does not imply shared authorization. `appId + tenantId + waAccountId` must still be resolved through the application's own authorization model.

### Security rule

Never trust a client-submitted `tenantId` or `waAccountId` as proof of access.

A logged-in user must first be authorized by the consuming application's own database/session layer. Only then may the application call the Operator for the authorized account.

## 6. Environment configuration

A consuming application normally needs:

```bash
OPERATOR_URL=https://my-own-whatsapp-2z5h.onrender.com
OPERATOR_API_KEY=<server-side secret matching the Operator>
WEBHOOK_SECRET=<server-side secret matching the Operator>
APP_ID=<stable application identifier>
APP_URL=https://your-application.example.com
```

The Operator requires:

```bash
DATABASE_URL=...
WEBHOOK_SECRET=...
OPERATOR_API_KEY=...
PORT=3001
LOG_LEVEL=info
NODE_ENV=production
```

`OPERATOR_API_KEY` and `WEBHOOK_SECRET` are secrets. Keep them server-side only.

Never expose either value through:

- frontend bundles;
- `NEXT_PUBLIC_*` variables;
- HTML source;
- browser localStorage;
- public API responses;
- client-side logs.

Production webhook URLs must be public HTTPS URLs. Do not use `localhost` or `127.0.0.1` in production.

## 7. Authentication and scope headers

Protected Operator routes use:

```http
X-API-Key: <OPERATOR_API_KEY>
```

The operator console also sends application scope headers:

```http
X-App-Id: <appId>
X-Tenant-Id: <tenantId>
```

Consuming applications should keep the Operator key on their server and proxy/mediate privileged actions rather than exposing the key to browsers.

## 8. First-time WhatsApp pairing flow

The Operator supports two pairing methods.

### QR flow

```text
Application
   ↓
POST /accounts/:id/connect
   ↓
Operator starts WhatsApp session
   ↓
GET /accounts/:id/qr every ~3 seconds
   ↓
Display fresh QR
   ↓
Business owner scans with WhatsApp → Linked Devices → Link a device
   ↓
GET /accounts/:id/status
   ↓
status=connected / isConnected=true
```

### Phone-number pairing-code flow

```text
Application
   ↓
POST /accounts/:id/pairing-code
   ↓
Operator returns short-lived code
   ↓
Business owner opens WhatsApp
   ↓
Linked Devices → Link a device → Link with phone number instead
   ↓
Owner enters the code
   ↓
Application polls /status
   ↓
connected
```

A phone number typed into the website is not, by itself, authentication. The business owner must authorize the link from the actual WhatsApp account they want to connect.

## 9. Account API

All routes below require the Operator API key.

### Health

```http
GET /health
```

No API key required.

### Bootstrap a beginner-friendly account

```http
POST /accounts/bootstrap
```

Example:

```json
{
  "label": "NahaLabs WhatsApp",
  "appId": "my-app",
  "tenantId": "tenant_123",
  "webhookUrl": "https://my-app.example.com/api/webhooks/whatsapp"
}
```

The Operator reuses an existing account already bound to the requested `appId + tenantId`, otherwise it creates one, creates the binding, and starts the session.

### Create an account explicitly

```http
POST /accounts
```

Example:

```json
{
  "label": "Acme Salon",
  "appId": "acme",
  "tenantId": "tenant_123",
  "webhookUrl": "https://acme.example.com/api/webhooks/whatsapp"
}
```

The webhook may be omitted during first-time pairing and configured later.

### List accounts

```http
GET /accounts
```

Returns account identifiers, labels, phone numbers, status, and connection state.

### Start/restart connection

```http
POST /accounts/:id/connect
```

### Get QR state

```http
GET /accounts/:id/qr
```

The response includes fields such as:

```json
{
  "status": "qr_ready",
  "isConnected": false,
  "qrCode": "data:image/png;base64,...",
  "qrGeneratedAt": "...",
  "qrExpiresAt": "...",
  "qrImageUrl": "/accounts/<id>/qr.png",
  "qrPollIntervalMs": 3000
}
```

QR responses are explicitly non-cacheable.

### Get QR PNG

```http
GET /accounts/:id/qr.png
```

Useful when a frontend wants an `<img>` endpoint instead of a data URL.

### Get pairing code

```http
GET /accounts/:id/pairing-code
```

### Request pairing code

```http
POST /accounts/:id/pairing-code
Content-Type: application/json
```

Example:

```json
{
  "phoneNumber": "+27 82 123 4567"
}
```

The number must be provided in international format. Pairing codes are temporary.

### Connection status

```http
GET /accounts/:id/status
```

Typical successful result:

```json
{
  "waAccountId": "uuid",
  "status": "connected",
  "isConnected": true,
  "phoneNumber": "27821234567"
}
```

### Disconnect

```http
POST /accounts/:id/disconnect
```

This intentionally logs the WhatsApp account out and clears its saved credentials.

### Reset

```http
POST /accounts/:id/reset
```

Use when a fresh clean pairing is intentionally required, for example after a terminal/bad session or when linking a different WhatsApp number.

Do not automatically reset every transient disconnect.

## 10. Outbound WhatsApp messaging

Primary endpoint:

```http
POST /send
```

Example text message:

```json
{
  "waAccountId": "uuid",
  "to": "27821234567",
  "type": "text",
  "text": "Your order is confirmed."
}
```

Recipients may be supplied as a phone number or a WhatsApp JID. Phone numbers are normalized into `@s.whatsapp.net`; group JIDs using `@g.us` are accepted.

### Currently supported outbound types

The Operator currently supports these `type` values:

| Type | Main fields |
|---|---|
| `text` | `text` |
| `image` | `url`, optional `caption` |
| `video` | `url`, optional `caption`, `gifPlayback`, `ptv` |
| `audio` | `url`, optional `mimetype`, `ptt` |
| `document` | `url`, `fileName`, optional `mimetype`, `caption` |
| `sticker` | `url` |
| `location` | `latitude`, `longitude`, optional `name`, `address` |
| `contact` | `displayName`, `vcard` |
| `poll` | `name`, `values`, `selectableCount` |
| `reaction` | `text`, referenced message key fields |

Quoted/replied messages can be supplied with a `quotedMessage` object where supported by the endpoint.

### Example image

```json
{
  "waAccountId": "uuid",
  "to": "27821234567",
  "type": "image",
  "url": "https://cdn.example.com/catalog/item-123.jpg",
  "caption": "Your requested item"
}
```

### Example document

```json
{
  "waAccountId": "uuid",
  "to": "27821234567",
  "type": "document",
  "url": "https://cdn.example.com/invoices/INV-1001.pdf",
  "fileName": "INV-1001.pdf",
  "mimetype": "application/pdf",
  "caption": "Your invoice"
}
```

### Example location

```json
{
  "waAccountId": "uuid",
  "to": "27821234567",
  "type": "location",
  "latitude": -26.10,
  "longitude": 28.24,
  "name": "NahaLabs Store",
  "address": "Example Road"
}
```

Do not place domain rules such as “send invoice” or “reply to lead” directly inside the transport adapter. Those decisions belong in the application.

## 11. Message operations

The Operator exposes message actions through `/messages`.

### Mark messages read

```http
POST /messages/read
```

### Presence

```http
POST /messages/presence
```

Allowed values:

```text
available
unavailable
composing
recording
paused
```

### Edit a message

```http
POST /messages/edit
```

### Delete a message

```http
POST /messages/delete
```

Use these only when the application's UX and business rules justify them. Do not build critical business state around WhatsApp read/presence behavior.

## 12. Inbound webhooks

The Operator forwards inbound events to the active binding's `webhookUrl`.

Request headers include:

```http
Content-Type: application/json
X-Webhook-Signature: <hex HMAC-SHA256>
X-Webhook-Schema-Version: 1
X-Webhook-Event: message
X-WhatsApp-Account-Id: <waAccountId>
```

Payload structure:

```json
{
  "schemaVersion": 1,
  "waAccountId": "uuid",
  "appId": "my-app",
  "tenantId": "tenant_123",
  "event": "message",
  "data": {},
  "deliveredAt": "2026-09-12T00:00:00.000Z"
}
```

The signature is HMAC-SHA256 using `WEBHOOK_SECRET` over the exact JSON payload.

### Important receiver rule

Verify the signature **before** doing business logic.

Do not trust the `tenantId` from an unsigned request or a request with an invalid signature.

## 13. Normalized inbound message

For `event = message`, `data` includes a normalized representation such as:

```json
{
  "provider": "whatsapp-web",
  "messageId": "...",
  "chatId": "...",
  "senderId": "...",
  "fromMe": false,
  "pushName": "Customer name",
  "timestamp": 1750000000,
  "messageType": "conversation",
  "text": "Hello",
  "media": null,
  "quotedMessageId": null,
  "quotedParticipant": null,
  "rawMessage": {}
}
```

The normalized fields are the preferred application integration surface. Keep the raw Baileys message only where a transport-specific feature genuinely needs it.

## 14. Webhook events

The Operator can forward message and other WhatsApp-side events through the same signed webhook mechanism, including connection, call, receipt, reaction, presence, contact, and group related events.

Applications should switch behavior using the `event` field instead of trying to infer event type from random raw payload fields.

## 15. Webhook retry and dead letters

The Operator retries webhook delivery up to 3 attempts.

Retry timing is approximately:

```text
attempt 1 → immediate
attempt 2 → ~1 second later
attempt 3 → ~2 seconds later
```

After the final failure, the event is persisted in the `wa_webhook_dead_letters` table.

Therefore, application webhook handlers should still be idempotent. A successful HTTP response should mean the application accepted the event for processing.

Recommended pattern:

```text
Webhook request
   ↓
Verify signature
   ↓
Check message/event idempotency key
   ↓
Persist/queue event
   ↓
Return 2xx quickly
   ↓
Process business logic asynchronously
```

Do not perform long-running AI generation or external API calls before acknowledging a webhook if the application can use a queue/job worker instead.

## 16. Inbound media

For inbound media, the normalized event identifies media metadata such as mimetype, filename, and caption.

The application may retrieve the actual media using:

```http
POST /media/download
```

Example:

```json
{
  "waAccountId": "uuid",
  "message": { "raw WhatsApp message object" }
}
```

The Operator returns the media bytes with the detected MIME type and an appropriate filename where available.

Applications should normally stream/store media into their own object storage rather than keeping large media blobs in the application database.

## 17. Call handling

The Operator currently exposes:

```http
POST /calls/reject
```

This is for rejecting an incoming WhatsApp call.

Do not assume the Operator provides a reliable Node-side voice/video bridge. The current implementation intentionally does not promise a full WhatsApp voice/video calling platform.

## 18. Automation possibilities

The WhatsApp Operator is the transport layer. **Automations are normally implemented in the consuming application.**

The following are valid application-level automation patterns.

### AI customer support

```text
Incoming WhatsApp message
   ↓
Signed webhook
   ↓
Identify tenant + customer
   ↓
Load conversation/history
   ↓
AI classification / response generation
   ↓
Safety + permission checks
   ↓
POST /send
   ↓
Persist response
```

Possible behaviors:

- answer FAQs;
- qualify leads;
- ask follow-up questions;
- search a product catalog;
- check order status;
- summarize conversations;
- route to a human agent;
- detect urgency/sentiment;
- hand off to a specialist queue.

### Human handoff

```text
AI conversation
   ↓
Escalation rule triggered
   ↓
Set tenant/customer to human mode
   ↓
Notify support dashboard
   ↓
Stop automatic AI replies
```

The Operator already has application-level controls in the database for AI/manual behavior. Do not bypass these controls with a second hidden automation path.

### Lead capture

```text
"Hi"
 ↓
Create/update lead
 ↓
Ask qualification questions
 ↓
Store answers
 ↓
Assign salesperson
 ↓
Send confirmation
```

### Booking automation

```text
Customer asks for appointment
 ↓
Application checks calendar
 ↓
Offer available slots
 ↓
Customer selects slot
 ↓
Create booking
 ↓
Send confirmation
 ↓
Schedule reminder
```

The reminder scheduler belongs to the application/job system, not to the WhatsApp Operator itself.

### Order automation

```text
Order paid
 ↓
Application event/queue
 ↓
Generate customer message
 ↓
POST /send
```

Examples:

- order received;
- payment confirmed;
- invoice ready;
- packed;
- shipped;
- out for delivery;
- delivered;
- refund processed.

### Appointment reminders

Use application scheduling/cron/workers:

```text
Booking database
 ↓
Scheduler/worker
 ↓
Select due reminders
 ↓
POST /send
 ↓
Record delivery result
```

### Customer re-engagement

Allowed only when consistent with the application's permissions, customer expectations, applicable rules, and WhatsApp restrictions. Do not implement unsolicited bulk messaging.

### Internal alerts

A NahaLabs application can use WhatsApp to notify authorized staff about:

- new orders;
- new leads;
- failed payments;
- support escalations;
- important bookings;
- operational incidents.

### Media automation

An application can receive a customer photo/document, download it through `/media/download`, process it, store it, and send a result back through `/send`.

Examples:

- proof-of-payment intake;
- product photo analysis;
- document collection;
- support attachments;
- delivery proof;
- invoice/receipt sending.

### CRM synchronization

```text
WhatsApp message
 ↓
Webhook
 ↓
Find/create CRM contact
 ↓
Append timeline event
 ↓
Run automation
```

Never use the WhatsApp account itself as the source of truth for customer records. The application database remains authoritative.

### AI agent tools

An AI assistant can use the application as a tool layer:

```text
WhatsApp
 ↓
AI assistant
 ├─ customer lookup
 ├─ order lookup
 ├─ stock lookup
 ├─ booking lookup
 ├─ invoice creation
 ├─ support ticket creation
 └─ WhatsApp reply through Operator
```

The AI should call business-domain tools and then use the Operator only for the communication action.

## 19. Recommended application architecture

Use a small transport adapter:

```ts
export interface WhatsAppTransport {
  bootstrap(input: BootstrapInput): Promise<BootstrapResult>;
  connect(accountId: string): Promise<void>;
  getQr(accountId: string): Promise<QrResult>;
  requestPairingCode(accountId: string, phoneNumber: string): Promise<PairingResult>;
  getStatus(accountId: string): Promise<StatusResult>;
  reset(accountId: string): Promise<void>;
  disconnect(accountId: string): Promise<void>;
  send(message: OutboundWhatsAppMessage): Promise<SendResult>;
}
```

Implementation:

```text
Domain / Application services
            ↓
      WhatsAppTransport
            ↓
 NahaLabs Operator HTTP adapter
```

Do not make the domain layer import Operator-specific HTTP code directly in dozens of files.

## 20. Browser/admin UI rules

For an admin dashboard that lets a user connect WhatsApp:

- keep the Operator API key on the server;
- let the authenticated user trigger a server-side action;
- show connection state clearly;
- poll the QR/status endpoint during pairing;
- stop polling after connection;
- never store a QR code in long-lived browser storage;
- never store pairing codes in localStorage;
- show QR expiry and refresh behavior;
- provide a clean reset/retry action;
- make it obvious which WhatsApp number is connected;
- prevent users from selecting another tenant's `waAccountId`.

For the business owner, the only physical authorization step should be the WhatsApp linking action on their actual phone.

## 21. QR rules

QR codes are temporary credentials for pairing.

The application must:

- request fresh QR state;
- poll about every 3 seconds while pairing;
- preserve the white quiet zone;
- display the QR at a usable size;
- never crop, recolor, blur, overlay, or transform it;
- respect cache-control headers;
- stop showing the QR after `isConnected=true`;
- display a refresh state after expiry.

A generated QR does not prove successful pairing. Only the successful connection state does.

## 22. Connection/reconnect rules

Do not delete credentials for every disconnect.

Expected policy:

```text
transient disconnect
    → reconnect, preserve credentials

logged out
    → require fresh pairing

bad/terminal session
    → clean reset, then fresh pairing

connection replaced elsewhere
    → avoid reconnect loops and surface status
```

Do not create a reconnect loop from multiple application workers. The Operator owns socket lifecycle.

## 23. Data persistence rules

The Operator's PostgreSQL database stores WhatsApp infrastructure state including:

- `wa_accounts`;
- `wa_sessions`;
- `wa_signal_keys`;
- `wa_account_bindings`;
- `wa_controls`;
- `wa_blocklist`;
- `wa_webhook_dead_letters`.

The application should store its own domain records separately:

- contacts;
- conversations;
- orders;
- tickets;
- bookings;
- products;
- AI state;
- audit events;
- business preferences.

Do not couple application schema directly to Baileys internal structures when a normalized model will work.

## 24. Idempotency and duplicate protection

Webhook delivery may be retried. Business actions must therefore be idempotent.

For inbound messages, use a stable message identifier such as:

```text
waAccountId + messageId
```

For business operations, generate your own idempotency key where the domain operation can be retried.

Examples:

```text
order-confirmation:<orderId>
booking-reminder:<bookingId>:<reminderType>
invoice:<invoiceId>
lead-welcome:<leadId>
```

Never assume “one webhook request equals one business action.”

## 25. Queues and background workers

Anything slow should move out of the webhook request path.

Good worker candidates:

- AI response generation;
- document processing;
- media analysis;
- OCR or classification;
- CRM synchronization;
- bulk report generation;
- scheduled reminders;
- retrying business actions;
- reconciliation jobs.

Pattern:

```text
Webhook
 ↓
Verify + authorize
 ↓
Persist/queue
 ↓
HTTP 2xx
 ↓
Worker
 ↓
Domain logic
 ↓
WhatsAppTransport.send()
```

## 26. Scheduled automations

The Operator itself is not the business scheduler.

For recurring actions use the application's scheduler/cron/worker infrastructure, for example:

```text
Every minute
 ↓
Find due notifications
 ↓
Check customer/tenant status
 ↓
Send through Operator
 ↓
Record result
```

This separation prevents the WhatsApp transport service from becoming a business-logic monolith.

## 27. Safety and permissions

Every automation must respect the application's:

- tenant boundaries;
- user permissions;
- customer opt-out/blocklist rules;
- manual/human mode;
- AI enablement rules;
- rate/volume controls;
- audit requirements.

Do not send messages merely because an LLM decided it is “probably okay.” The application should enforce policy before calling `/send`.

The Operator also exposes blocklist/control persistence. Integrations should preserve those controls instead of bypassing them.

## 28. What not to do

Do not:

- import Baileys in an application;
- create a second WhatsApp socket;
- add Evolution API without an explicit provider decision;
- add Twilio without an explicit provider decision;
- replace this transport with Meta Cloud API without an explicit migration decision;
- expose `OPERATOR_API_KEY` in a browser;
- expose `WEBHOOK_SECRET` in a browser;
- trust browser-supplied tenant IDs for authorization;
- use stale QR codes;
- store pairing codes in localStorage;
- hard-code guessed WhatsApp protocol versions;
- delete credentials after every disconnect;
- use local disk as the application's long-term source of WhatsApp credentials;
- implement business rules inside the transport adapter;
- send unsolicited bulk/spam messages;
- claim a WhatsApp account is connected merely because a QR or pairing code was generated.

## 29. Testing requirements

Every WhatsApp-enabled application should test:

### Authentication

- wrong Operator API key;
- missing API key;
- missing webhook secret;
- unauthorized tenant;
- unauthorized `waAccountId`.

### Pairing

- new account;
- already-connected account;
- QR generation;
- QR expiry;
- QR refresh;
- phone-number pairing code;
- pairing-code expiry;
- pairing success;
- pairing cancellation/failure;
- reset;
- disconnect.

### Messaging

- text send;
- media send;
- invalid recipient;
- disconnected account;
- invalid media URL;
- unsupported message type;
- reply/quoted message;
- read/presence/edit/delete actions.

### Webhooks

- valid signature;
- invalid signature;
- duplicate event;
- retry;
- webhook timeout;
- webhook 500;
- dead-letter recording;
- no webhook configured.

### Automation

- AI disabled/manual mode;
- blocked customer;
- customer opt-out;
- duplicate order event;
- scheduler retry;
- human handoff;
- Operator outage;
- application outage.

## 30. Troubleshooting order

When something fails, use this order:

1. Confirm the Operator service is running.
2. Check the deployment/build status.
3. Check Operator logs.
4. Confirm the account exists.
5. Confirm the account is connected.
6. Confirm application tenant authorization.
7. Confirm webhook signature verification.
8. Confirm the webhook returned 2xx.
9. Check for webhook dead letters.
10. Only then inspect AI/business logic.

Do not randomly modify QR code rendering, Baileys versions, session credentials, or provider configuration before inspecting the evidence.

## 31. Future Meta migration strategy

The application architecture should remain:

```text
Business domain
      ↓
WhatsAppTransport
      ↓
Current: NahaLabs Operator / WhatsApp Web
```

Later:

```text
Business domain
      ↓
WhatsAppTransport
      ↓
Future: Meta Cloud API adapter
```

The migration should primarily replace the adapter and onboarding/pairing experience. CRM, orders, support, booking, AI, audit, and automation logic should not know whether the current transport is Baileys or Meta.

## 32. Example end-to-end integration

### Server-side send helper

```ts
export async function sendWhatsAppText(
  accountId: string,
  to: string,
  text: string,
): Promise<void> {
  const response = await fetch(`${process.env.OPERATOR_URL}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.OPERATOR_API_KEY!,
    },
    body: JSON.stringify({
      waAccountId: accountId,
      to,
      type: 'text',
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`WhatsApp send failed: ${response.status} ${body}`);
  }
}
```

In a real production application, add application-side authorization, structured error handling, tracing, idempotency, and retry policy appropriate to the business operation.

### Example webhook flow

```ts
export async function whatsappWebhook(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Webhook-Signature');

  verifyHmacOrThrow(rawBody, signature, process.env.WEBHOOK_SECRET!);

  const event = JSON.parse(rawBody) as {
    schemaVersion: number;
    waAccountId: string;
    appId: string;
    tenantId: string;
    event: string;
    data: unknown;
  };

  await assertAuthorizedBinding(event.appId, event.tenantId, event.waAccountId);
  await enqueueIdempotently(event);

  return new Response(null, { status: 204 });
}
```

## 33. AI coding assistant final checklist

Before completing any task involving this WhatsApp system, verify:

```text
[ ] Existing Operator reused
[ ] No direct Baileys import in consuming app
[ ] Operator URL configured server-side
[ ] API key server-side only
[ ] Webhook secret server-side only
[ ] Tenant authorization enforced
[ ] waAccountId ownership enforced
[ ] Webhook HMAC verification implemented
[ ] Idempotency implemented
[ ] Long-running work moved to queue/worker when appropriate
[ ] Business logic remains outside transport layer
[ ] QR expiry handled
[ ] Connection state handled
[ ] Disconnect/reset semantics preserved
[ ] Customer opt-out/blocklist/manual mode respected
[ ] Tests cover success and failure paths
[ ] Typecheck/build/tests passed
[ ] Deployment result verified before claiming completion
```

## 34. Final instruction

**Treat this document and the current Operator source code as the source of truth.**

When changing the system, prefer the smallest safe change, reuse existing endpoints and abstractions, preserve tenant isolation, preserve secrets, preserve persisted sessions, and verify actual deployment/runtime evidence.

Never tell the user that WhatsApp is connected until the real WhatsApp authorization has completed and the Operator reports the account as connected.
