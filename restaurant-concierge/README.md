# NahaLabs Restaurant Concierge

Per-branch restaurant WhatsApp service on top of the shared [WhatsApp Operator](../whatsapp-operator/).
The Operator owns the WhatsApp sockets; this service owns the restaurant brain's plumbing:
branch configs, conversation storage, agent notifications, and reply relay.

```text
Customer WhatsApp
      ↓ (Baileys socket)
WhatsApp Operator  ──signed webhook (HMAC-SHA256)──▶  Restaurant Concierge
                                                         │  stores message (rc_messages)
                                                         │  emails notification (Resend) ──▶ owner Gmail ──▶ wakes the AI agent
                                                         ▲
AI agent (Instinct)  ──GET /v1/inbox, POST /v1/replies──┘
                                                         │ live branch: Operator /send as the branch's WhatsApp
                                                         │ test branch: recorded only, nothing sent
```

The concierge is deliberately dumb: no AI, no auto-replies. The agent reads branch
config (menu, hours, rules, voice) from `GET /v1/branches`, decides what to say,
and posts replies. Nothing goes to a customer without an agent action.

## Adding a branch (the whole onboarding)

1. **Add a config file.** Copy `branches/_example.json` to `branches/<branch-id>.json`
   and fill it in (menu, trading hours, booking rules, escalation contact, voice).
   Files starting with `_` are ignored. `mode` stays `"test"` until pairing is done.
2. **Deploy** (push to `main`; Render auto-deploys). The config is loaded at boot.
3. **Provision the Operator account** (creates the account + webhook binding;
   safe to re-run, never touches other apps' bindings on the same number):
   ```bash
   OPERATOR_BASE_URL=https://my-own-whatsapp-2z5h.onrender.com \
   OPERATOR_API_KEY=... CONCIERGE_PUBLIC_URL=https://<this-service>.onrender.com \
   ./scripts/onboard-branch.sh <tenantId>
   ```
4. **Pair the branch phone.** Open `GET <operator>/accounts/<waAccountId>/qr.png`
   (headers: `X-API-Key`, `X-App-Id: restaurant-concierge`, `X-Tenant-Id: <tenantId>`)
   and have the branch scan it: WhatsApp → Linked Devices → Link a device.
   Best: the branch's EXISTING WhatsApp number — customers keep messaging the same number.
5. **Paste the `waAccountId`** from step 3 into the branch JSON and flip `mode` to `"live"`. Push.
6. The owner can disconnect any time from their own WhatsApp's linked-devices list.

## Test mode

`"mode": "test"` branches never touch real WhatsApp:

```bash
# Simulate a customer message (same store + notify pipeline as the real webhook)
curl -X POST $CONCIERGE/v1/test/inbound -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"branchId": "soweto-test", "from": "+27761234567", "text": "Table for 2 tonight?"}'

# Agent replies are recorded but NOT sent
curl -X POST $CONCIERGE/v1/replies -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"branchId": "soweto-test", "to": "+27761234567", "text": "Yes, 7pm?"}'
# → {"ok": true, "simulated": true, ...}

# Inspect what would have been sent
curl "$CONCIERGE/v1/test/outbox/soweto-test?customer=%2B27761234567" -H "X-API-Key: $KEY"
```

`soweto-test` ships in the repo for exactly this.

## Agent contract (`/v1/*`, header `X-API-Key: $CONCIERGE_API_KEY`)

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/branches` | All branch configs: menu, hours, booking rules, escalation, voice |
| `GET /v1/inbox?branchId=&status=pending` | New customer messages to answer |
| `GET /v1/conversations/:branchId/:phone` | Full thread with one customer |
| `POST /v1/replies {branchId, to, text}` | Reply (live: real WhatsApp; test: simulated) |
| `POST /v1/messages/:id/status {status}` | `pending` / `replied` / `archived` |
| `POST /v1/test/inbound` | Simulated inbound, test branches only |
| `GET /v1/test/outbox/:branchId` | Simulated/sent replies for inspection |

Phone numbers in **query strings** must be URL-encoded (`%2B2776...`, a raw `+` becomes a space). In path segments and JSON bodies a plain `+` is fine.

## How the agent hears about messages

Two mechanisms, belt and braces:

1. **Email notification (seconds).** `NOTIFIER=resend` sends one email per inbound
   message via [Resend](https://resend.com) (free tier: 100/day — fine for a pilot).
   A Gmail wake-subscription on the recipient mailbox wakes the agent when a
   notification arrives. Set a Gmail filter to skip the inbox for these so the
   owner's mailbox stays clean.
2. **Polling fallback.** `GET /v1/inbox?status=pending` always has the truth;
   notification failure never loses a message.

Agent Mail was considered and rejected: there is no event-driven wake source for
the agent mailbox, so replies would lag by the polling interval.

## Database

Shares the Operator's Postgres (`DATABASE_URL`). Creates only `rc_messages`
(idempotent, at boot) and never touches `wa_*` tables. Same database means one
fewer secret to manage; the prefix keeps ownership obvious.

## Environment

See [.env.example](.env.example). Required: `DATABASE_URL`, `WEBHOOK_SECRET` (same
as Operator), `CONCIERGE_API_KEY`, `OPERATOR_BASE_URL`, `OPERATOR_API_KEY`.
Notifications: `NOTIFIER=resend`, `RESEND_API_KEY`, `NOTIFY_TO`.

## Safety notes

- Unofficial WhatsApp Web transport: keep volumes low, replies only. See the repo
  README — a number can get restricted if abused.
- The webhook route only accepts `message` events for configured branch tenants;
  Flavourly and other tenants' traffic is acked and ignored, never stored.
- Group chats, status broadcasts and the branch's own messages are ignored.
