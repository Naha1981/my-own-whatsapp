# NahaLabs Engineering Standard + WhatsApp Operator

This repository combines the NahaLabs engineering standards with a reusable self-hosted WhatsApp Operator for applications that need WhatsApp connectivity before moving to official Meta infrastructure.

## WhatsApp platform

`whatsapp-operator/` is a shared, self-hosted WhatsApp Web/Linked Devices transport built on Baileys. A business owner connects **their own WhatsApp number** by scanning a QR code shown inside the consuming application's dashboard. The application never handles the owner's WhatsApp password or credentials.

The Operator provides:

- persistent one-socket-per-account WhatsApp connections
- Postgres-backed Baileys credentials and Signal keys
- high-error-correction 512px QR PNG generation with a preserved quiet zone
- QR expiry metadata, no-cache responses, and a direct `.png` endpoint
- business-owner QR pairing through WhatsApp Linked Devices
- safe reconnect, stale-socket protection, clean reset, and terminal bad-session recovery
- pairing-success diagnostics
- authenticated outbound message sending
- signed inbound webhooks with retry/dead-letter storage
- a reusable HTTP contract so applications remain independent of Baileys

The PDF reference architecture is used as the operating baseline: the main application talks to a persistent Operator over HTTP, while the Operator owns the Baileys sockets and persistence. fileciteturn0file0L9-L30

## Repository layout

```text
docs/
  ENGINEERING_CONSTITUTION.md
  CLAUDE.md
  SECURITY_CHECKLIST.md
  whatsapp-architecture.md
  WHATSAPP_OPERATOR_INTEGRATION.md
  adr/0000-template.md
  templates/GATE_REPORT.md

whatsapp-operator/
  src/                         # Node.js + TypeScript + Baileys
  db/schema.sql                # Postgres schema
  README.md                    # operator deployment + API + QR pairing guide
  Dockerfile

.github/workflows/ci.yml       # typecheck + build verification
render.yaml                    # Render deployment blueprint
```

## Reuse from an application

Deploy `whatsapp-operator/` once on a persistent host and PostgreSQL. Each application then:

1. creates/binds a WhatsApp account with its app and tenant IDs;
2. starts the account and polls `/accounts/:id/qr` every ~3 seconds;
3. displays the fresh QR to the business owner;
4. lets the owner scan it from WhatsApp → Linked Devices → Link a device;
5. waits for `/accounts/:id/status` to become `connected`;
6. receives signed inbound messages through its webhook; and
7. sends replies through `/send`.

See `docs/WHATSAPP_OPERATOR_INTEGRATION.md` for the complete contract and migration boundary.

## Positioning

This is an **unofficial** WhatsApp Web/Linked Devices integration. It is intended as a self-hosted bridge while applications are being validated. It is deliberately kept behind an application transport boundary so that a future migration to Meta's official WhatsApp Cloud API can replace the transport without rewriting business logic.

Use only in ways permitted for the connected WhatsApp accounts, and do not use the Operator for spam, bulk unsolicited messaging, or prohibited automation.

## Engineering rule

Establish the baseline. Understand the real architecture. Plan the smallest safe change. Build it. Test failure paths, not just happy paths. Verify the live deployment rather than assuming a merge means production is updated.

## License

MIT.
