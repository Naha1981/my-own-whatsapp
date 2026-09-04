# NahaLabs Engineering Standard

**The one repo you clone before you write a single line of any new NahaLabs application — small side project or enterprise contract (banks, government, insurers, mining, telcos).**

This repo is not a framework. It is:

1. A **software engineering constitution** — the lifecycle, gates, and rules every project follows (`docs/ENGINEERING_CONSTITUTION.md`).
2. An **AI operating contract** — what you paste into Claude/Codex/Cursor as the first message of any project (`docs/CLAUDE.md`).
3. A **self-hosted WhatsApp Operator** — your own free, un-official WhatsApp Business infrastructure. Business owner scans a QR code once, gets their own WhatsApp number connected, no Meta approval, no Twilio, no Evolution API, no monthly fee until you have a paying customer (`whatsapp-operator/`).

## How to use this repo

```bash
# 1. Clone it as the starting point for a new project
git clone https://github.com/<you>/nahalabs-engineering-standard.git my-new-app
cd my-new-app
rm -rf .git && git init

# 2. Paste docs/CLAUDE.md into your AI coding assistant as the first message
# 3. Follow docs/ENGINEERING_CONSTITUTION.md — Discover, Baseline, Plan, Gate, Build
# 4. If the app needs WhatsApp, deploy whatsapp-operator/ once (Render/Fly/Docker) and point every app at it
```

## What's inside

```
docs/
  ENGINEERING_CONSTITUTION.md   # the lifecycle + rules (read this first)
  CLAUDE.md                     # paste this into your AI assistant
  SECURITY_CHECKLIST.md         # 20-point pre-launch checklist
  whatsapp-architecture.md      # how the WhatsApp Operator works, plain English
  adr/0000-template.md          # Architecture Decision Record template
  templates/GATE_REPORT.md      # end-of-gate report format

whatsapp-operator/               # self-hosted, multi-tenant, QR-based WhatsApp
  src/                          # Node.js + TypeScript + Baileys
  db/schema.sql                 # Postgres schema (sessions, accounts, bindings)
  README.md                     # deploy + API docs
```

## The one-sentence version

Establish the baseline. Understand the real architecture. Plan the smallest safe change.
Build it. Test the failure paths, not just the happy path. Prove it works. Deploy in order.
Verify production. Never trust a claim you haven't personally verified against the real system.

## License

MIT. Use it, fork it, open-source your own version of it.
