# NahaLabs WhatsApp Automation Cookbook

These are application-level automation templates. They run in the consuming SaaS and use the NahaLabs Operator for WhatsApp transport.

## Automation architecture

```text
Incoming WhatsApp event
        ↓
Verify webhook signature
        ↓
De-duplicate
        ↓
Resolve tenant/account
        ↓
Automation router
        ├── AI assistant
        ├── lead capture
        ├── order workflow
        ├── booking workflow
        ├── support escalation
        └── internal alert
        ↓
Business action
        ↓
WhatsAppTransport.send()
```

## 1. AI customer support

**Trigger:** inbound text message.

**Flow:**
1. Normalize the incoming message.
2. Load tenant/customer context.
3. Check opt-out and manual-mode rules.
4. Send the message to the application's AI layer.
5. Generate a concise answer using only trusted business data.
6. Send the answer through `WhatsAppTransport.sendText()`.
7. Log the conversation and AI action.
8. Escalate to a human when confidence is low or the customer asks for a person.

**Safety:** never let an AI model invent prices, stock, payment status, order status, appointment times, policies, or account actions.

## 2. Lead capture

**Trigger:** first inbound message from an unknown contact.

**Flow:**
`message → create lead → capture name/company/intent → acknowledge → notify sales → continue conversation`

Suggested fields:
- phone number
- display name
- source = whatsapp
- first message
- intent
- assigned owner
- status
- createdAt

## 3. Instant FAQ responder

**Trigger:** inbound message containing a supported FAQ intent.

**Examples:**
- opening hours
- address
- delivery area
- service list
- booking link
- payment methods

Use a structured knowledge base where possible. Send the answer through the Operator rather than implementing WhatsApp logic in the FAQ module.

## 4. Order confirmation

**Trigger:** application marks an order as confirmed/paid.

```text
Order confirmed
      ↓
Create customer-safe message
      ↓
WhatsAppTransport.sendText()
      ↓
Persist notification result
```

Never send a payment-confirmed message solely because a browser/client told the system payment succeeded. Use the trusted backend payment state.

## 5. Order status notifications

**Trigger:** trusted order-state transition.

Example states:
`received → confirmed → preparing → ready → dispatched → delivered`

Send only on actual state transitions. Store the last notified state to prevent duplicate WhatsApp messages.

## 6. Appointment booking and reminders

**Trigger:** booking created/changed/cancelled.

Templates:
- booking confirmation
- 24-hour reminder
- 2-hour reminder
- cancellation
- reschedule
- no-show follow-up

The scheduler belongs in the application/queue layer. The Operator only transports the resulting WhatsApp message.

## 7. Payment notifications

**Trigger:** backend payment event.

Examples:
- payment received
- payment failed
- payment link generated
- invoice overdue

Never expose secret payment data in WhatsApp messages.

## 8. Abandoned-cart follow-up

**Trigger:** cart remains inactive beyond the application's configured threshold.

Recommended flow:
`cart abandoned → eligibility check → opt-out check → send one reminder → record campaign attempt`

Avoid repeated unsolicited messaging. Rate-limit campaigns and honor opt-outs.

## 9. Human handoff

**Trigger:** customer requests a human, AI confidence is low, or a sensitive issue is detected.

Flow:
`AI conversation → set manual mode → notify staff → optionally send “A team member will assist you” → stop automatic replies until staff releases the conversation`

The Operator already has application-level AI/manual controls. The SaaS should use the control state rather than inventing competing behavior.

## 10. Staff/internal alerts

**Trigger:** important customer or operational event.

Examples:
- high-value lead
- angry customer
- failed payment
- order exception
- delivery failure
- urgent support message

Use a separate internal notification channel where possible. Do not automatically leak internal notes to the customer chat.

## 11. Media/document workflow

Inbound media can be downloaded from the Operator using `/media/download` when the business workflow needs the original file.

Examples:
- customer sends proof of payment
- customer sends an ID/photo for a permitted business workflow
- customer sends a product image
- customer sends a document for processing

Before storing media, apply the application's privacy, retention, and access rules.

## 12. Read receipts and presence

The Operator exposes message read and presence operations.

Use them only when they improve the customer experience. Never use presence as a substitute for real application state.

## 13. Reusable event router

A recommended application router:

```ts
switch (event.event) {
  case 'message':
    return handleIncomingMessage(event);
  case 'receipt':
    return handleMessageReceipt(event);
  case 'reaction':
    return handleReaction(event);
  case 'presence':
    return handlePresence(event);
  case 'call':
    return handleCallEvent(event);
  case 'connection':
    return handleConnectionChange(event);
  case 'contact':
    return handleContactEvent(event);
  case 'group':
    return handleGroupEvent(event);
  default:
    return recordUnknownEvent(event);
}
```

Do not assume every event contains text. Use the event-specific normalized fields and preserve the raw payload for diagnostics where the application's privacy rules allow it.

## 14. Automation idempotency

Every action that can send a customer-facing WhatsApp message should have an idempotency key.

Examples:
- `order:<orderId>:confirmed`
- `appointment:<appointmentId>:24h`
- `lead:<leadId>:welcome`
- `cart:<cartId>:reminder-1`

Before sending, check whether the action has already completed. Mark completion only after the Operator reports success.

## 15. Queue pattern for production

For non-interactive work:

```text
Webhook
  ↓
Durable job queue
  ↓
Worker
  ↓
Business action
  ↓
WhatsApp Operator
```

Use a queue for reminders, campaigns, large notification batches, document processing, and other work that should survive application restarts.

Do not turn the WhatsApp Operator into a general-purpose business job runner.

## 16. Multi-tenant automation rule

Every automation decision must be scoped to:

- authenticated application context
- `appId`
- `tenantId`
- `waAccountId`
- customer/contact identity

A request must never be able to choose another tenant's `waAccountId` by simply changing a browser field or request body.

## 17. Common templates for AI-built SaaS apps

| App type | Recommended starter | Common automations |
|---|---|---|
| CRM | webhook + server client | lead capture, follow-up, human handoff |
| E-commerce | webhook + server client | order confirmation, status updates, abandoned cart |
| Booking app | webhook + scheduler | confirmations, reminders, reschedule |
| Support desk | webhook + AI router | FAQ, ticket creation, escalation |
| Restaurant | webhook + order adapter | menu/FAQ, order status, booking |
| Salon/clinic-style booking | webhook + scheduler | booking, reminders, cancellation |
| Marketplace | webhook + domain adapter | buyer/seller alerts, order events |
| AI assistant | webhook + AI layer | conversational replies, escalation |

## 18. What belongs where

**Operator:** WhatsApp connection, session persistence, QR/pairing, receiving events, sending messages, media transport.

**Application:** customers, orders, CRM, AI, schedules, permissions, tenant isolation, business rules, analytics.

**Queue/worker:** delayed jobs, reminders, retries for business workflows, bulk processing.

**Database:** application data, idempotency records, business state, audit events.

Keeping these boundaries intact means a new app can be assembled from templates without modifying the proven WhatsApp transport.
