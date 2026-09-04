# WhatsApp Architecture — Self-Hosted, QR-Based, No Meta Approval

## The rule
Never use the official Meta Cloud API, Twilio, Evolution API, or 360dialog by default. Use the
"Linked Devices" WebSocket approach (the same one WhatsApp Web uses) via `@whiskeysockets/baileys`,
run as your own free infrastructure. Pay a provider only once you have paying customers and a
real reason (e.g. you outgrow what you can self-host reliably).

## The two-server split (never skip this)
- **The Brain** — your Next.js app(s) on Vercel. UI, auth, database, business logic, AI, and the
  webhook receiver. Serverless, stateless.
- **The Engine** — the **WhatsApp Operator** in `whatsapp-operator/`, a persistent Node.js
  process (Render/Fly/Docker — anything that doesn't sleep). Holds the 24/7 WebSocket connection
  to WhatsApp. Survives your app's redeploys.

Never put the socket in the same process as a serverless function — it will die every time the
function goes cold.

## The business-owner flow (this is the QR experience you asked for)
1. Business owner signs up in **your app** (the Brain).
2. They click "Connect WhatsApp." Your app calls the Operator: `POST /accounts` → creates a
   `wa_account_id`, binds it to their tenant + your app's webhook URL.
3. Your app calls `POST /accounts/:id/connect`, then polls `GET /accounts/:id/qr` and shows the
   QR code image in their dashboard.
4. Owner scans it **once** with their phone (WhatsApp → Linked Devices). Their phone can now be
   turned off — the Operator keeps the session alive.
5. From their dashboard, they can re-display/download that same QR (or a WhatsApp deep link) to
   share with *their* customers — "chat with us on WhatsApp."
6. A customer messages the business number → the Operator receives it, looks up which app/tenant
   owns that number (`wa_account_bindings`), signs the payload with HMAC-SHA256, and `POST`s it to
   that app's webhook.
7. Your app verifies the signature, stores the message, runs your AI/business logic, and calls
   the Operator's `POST /send` to reply. Secured by a shared `OPERATOR_API_KEY`.

## One Operator, unlimited apps
The Operator isn't tied to one product. Deploy it **once**. `wa_account_bindings` maps
`wa_account_id → (app_id, tenant_id, webhook_url)`, so five different apps (a restaurant SaaS, a
logistics SaaS, a POS, whatever you build next) can all point at the same Operator URL and the
same `OPERATOR_API_KEY`. The Operator resolves each inbound message to the right app and forwards
it there. This is exactly what `whatsapp-operator/` implements.

## Multi-tenancy & isolation
- One live WhatsApp socket per `wa_account_id` — never two.
- Database enforces `tenant_id` scoping everywhere; tenant A can never see or send on tenant B's
  socket.
- Session credentials (Baileys `creds` + Signal key store) are persisted in Postgres, not on
  local disk — so the Operator survives redeploys/restarts without re-scanning the QR code.

## Safety & compliance
- Global master switch (DB-backed, not an env var) to instantly stop all AI processing without a
  redeploy.
- Per-tenant "manual mode" — log messages, don't let the AI reply.
- Listen for `STOP` / `UNSUBSCRIBE` / `OPT-OUT` and blocklist that sender for that tenant
  immediately (POPIA/GDPR).

## Why not the alternatives
- **Meta Cloud API**: business verification, template approval, cost per conversation, and Meta
  can suspend your number — not worth it before you have revenue.
- **Twilio / 360dialog**: same limitations, plus a per-message bill from day one.
- **Evolution API**: another team's infrastructure and breaking changes sitting between you and
  your customers' messages, for no benefit over owning the (free, open-source) Baileys socket
  directly.
- **Your own Operator**: free, self-owned, swappable later (you can migrate to the official Cloud
  API behind the same `sendMessage()` interface without touching any business code, the day it's
  worth paying for).

See `whatsapp-operator/README.md` for deployment and the API reference.
