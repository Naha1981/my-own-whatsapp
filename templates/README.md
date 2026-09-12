# NahaLabs WhatsApp Integration Templates

This directory is the reusable starting point for AI coding assistants building WhatsApp-enabled applications on top of the NahaLabs Operator.

## Rule

Do not rebuild WhatsApp transport from scratch. Start from one of these templates, copy only what the application needs, and keep the Operator itself unchanged unless the task is specifically an Operator infrastructure change.

## Available templates

### 1. `server-client.ts`
A small server-side TypeScript client for the deployed Operator. It covers:

- account bootstrap
- connection/status checks
- QR pairing
- phone-number pairing code
- text/media sending
- reset/disconnect

### 2. `webhook-handler.ts`
A framework-neutral inbound webhook handler pattern covering:

- HMAC signature verification
- event routing
- message normalization
- tenant/account resolution hooks
- idempotency hooks
- safe dispatch to business logic

### 3. `automations.md`
Reusable automation recipes for common SaaS products:

- AI customer support
- lead capture
- instant FAQ replies
- order/status notifications
- appointment confirmations/reminders
- payment notifications
- abandoned-cart follow-up
- customer opt-out handling
- human handoff
- internal staff alerts

## How an AI coding assistant should use these templates

1. Read `docs/WHATSAPP_FOR_CODING_ASSISTANTS.md`.
2. Read this file.
3. Select the smallest applicable template.
4. Adapt the template to the application's existing framework, authentication, tenant model, database, and UI.
5. Never copy Operator secrets into browser code.
6. Never import Baileys into the consuming application.
7. Never create a second WhatsApp socket/service when the shared Operator can perform the task.
8. Run the application's tests/typecheck/build before changing the Operator.
9. Only modify the Operator when the requested capability cannot be implemented at the application layer.

## Provider boundary

The application should call a small WhatsApp transport adapter. Business logic must not know about Baileys.

```text
Application feature
       |
       v
WhatsApp adapter
       |
       v
NahaLabs Operator HTTPS API
       |
       v
WhatsApp / Baileys
```

## Reuse across apps

Each application can point to the same deployed Operator while using its own `appId`, `tenantId`, webhook URL, and application-side authorization. The Operator's shared transport can therefore serve multiple NahaLabs products.

## Stability rule

The current production Operator is a known-good baseline. Template work must be additive and must not alter existing endpoints, session persistence, authentication, pairing behavior, or webhook signing unless the task explicitly requires a versioned change.
