# NahaLabs Engineering Constitution
**Version 1.0 — one standard for every app, from a weekend side-project to a bank/government/telco contract.**

This document is the constitution. The stack in Part 3 is the *default implementation profile* —
change it when a project genuinely needs to, but never change Parts 1, 2, 4–11 without writing an ADR.

---

## 0. Prime Directive

Build software that is correct, secure, reliable, observable, testable, and operable by someone
who did not write it — in that order of priority over speed of delivery.

> **Evidence beats confidence. A verified failure beats an assumed success.**

Never assume:
- a feature exists because someone described it — inspect the repo
- code works because an AI said it works — run it
- a commit is pushed because a session said it pushed — check `git log origin/main..HEAD`
- a migration ran because the migration file exists — check the database
- production behaves like local — test production
- a green UI indicator reflects reality — check the underlying state

If something can't be verified right now, say **UNVERIFIED**. Never convert uncertainty into confidence.

---

## 1. The Lifecycle

Every non-trivial change goes through this loop. Skipping a stage requires saying so out loud.

```
DISCOVER → BASELINE → ARCHITECTURE MAP → PLAN → GATE → IMPLEMENT (smallest change)
  → TEST (happy + failure + seam) → REVIEW DIFF → COMMIT → VERIFY REMOTE
  → DEPLOY → SMOKE TEST → OBSERVE → OPERATE → IMPROVE
```

### 1.1 Discover
Answer before writing code: what problem, who are the users, what's the business outcome,
what already exists/is deployed, what's the catastrophic-failure scenario.

### 1.2 Baseline (existing repo)
```bash
git status && git branch --show-current && git log --oneline -20
git fetch --all --prune --tags
git log origin/main..HEAD   # unpushed commits
git log HEAD..origin/main   # commits you don't have
```
Never claim "everything is committed/pushed" without running this.

### 1.3 Architecture Map
Derive the architecture from the repo — never invent it. For an **existing** app, classify every
significant component: `KEEP / MIGRATE / REWRITE / REMOVE / DEPRECATE`, with a reason and risk
level, and get sign-off before touching it (see §9, Modes A/B).

### 1.4 Plan (before code)
State: Objective · Non-goals · Assumptions to verify · Risks (Critical/High/Med/Low) ·
Files expected to change · Data changes · API contract changes · Test plan.

### 1.5 Gates
Divide work into bounded gates, never "build the whole app":
`G0 Security & foundation → G1 Vertical slice (pilot) → G2 Production readiness → G3 Scale`.
Each gate: Objective, Scope, Non-goals, Baseline, Risks, Tests, Verification commands,
Rollback plan, **PASS/FAIL** — use `templates/GATE_REPORT.md`.

### 1.6 Implement
Smallest correct change. No unrelated refactors, no drive-by dependency upgrades, no renamed
files "while I'm in there." Search before you create — never leave `Hero-v2.tsx` next to `Hero.tsx`.

### 1.7 Test
Unit (pure logic) → Integration (API→service→DB) → Seam (route actually calls the dispatcher,
not just "the helper works in isolation") → E2E (real user journey, real browser).
Deliberately test failure paths: missing env var, timeout, duplicate webhook, worker crash,
DB unavailable, malformed payload, unauthorized user, race condition. Mutation-test critical
logic: flip a guard, skip idempotency — the tests must fail, or they weren't testing anything.

### 1.8 Commit / Verify remote
Small, meaningful commits (`fix(webhook): fail closed when secret is missing`, not `updates`).
`git diff` before committing, `git show --stat` after. Verify the remote SHA, don't assume it.

### 1.9 Deploy
Env vars → app → workers/operators → migrations → health check → readiness check →
cron/scheduler auth verified → scheduler proven to run repeatedly → external services connected
→ real end-to-end smoke test. **Configured ≠ running. Running ≠ processing. Processing ≠ succeeding.**

### 1.10 Observe / Operate / Improve
Structured logs with a trace ID, health + readiness endpoints, queue depth visibility, error
tracking, a runbook someone else can follow. Every real bug becomes a regression test.

---

## 2. Golden Rules

1. Never trust a summary over the repository.
2. Never trust a green UI indicator over the underlying system state.
3. Never trust "success" unless the defined side effect actually happened.
4. Never test only the happy path.
5. Never introduce infrastructure (Redis, a queue, a microservice) without a real problem it solves.
6. Never upgrade a dependency without knowing the vulnerability, the reachable code path, and the risk.
7. Never merge unverified work; never deploy a migration-dependent change without checking deploy order.
8. A passing test suite is evidence, not proof — test the seams and the real user journey.
9. Fast code that silently loses customer data is not successful engineering.
10. Stop and ask before: deleting production data, changing auth providers, dropping columns,
    touching payment infra, irreversible migrations, rotating production secrets, force-pushing,
    merging to main, or deploying anything destructive.

**Decision priority when trading off:** data integrity → security → correctness → reliability →
recoverability → observability → maintainability → performance → developer convenience → speed.

---

## 3. Default Stack (the implementation profile, not dogma)

One choice per layer. Deviating requires an ADR.

| Layer | Default | Why |
|---|---|---|
| Framework | Next.js (App Router) + TypeScript strict | Frontend + backend, one repo, one deploy |
| UI | Tailwind + shadcn/ui | Design tokens, no ad-hoc styling |
| Forms/validation | React Hook Form + Zod | One schema, client + server |
| Client data | TanStack Query | No `fetch` in `useEffect` |
| Database | PostgreSQL (Neon/Supabase) | Serverless, pgvector-ready, one DB for everything |
| ORM | Drizzle | Typed, simple migrations |
| Auth | Clerk (or the client's mandated IdP for enterprise work) | Never build custom auth |
| AI | Vercel AI SDK, provider-agnostic | Never import a provider SDK directly |
| Messaging | **Self-hosted WhatsApp Operator** (this repo, `whatsapp-operator/`) | Own the infra, no Meta/Twilio/Evolution dependency |
| Payments | PayFast/Stripe behind one abstraction | Webhooks are truth, browser redirects are not |
| Background jobs | Postgres queue (`FOR UPDATE SKIP LOCKED`) + external cron (cron-job.org) | No Vercel-native cron on the free plan |
| Deployment | Vercel (app) + Render/Fly/Docker (stateful operator) | Serverless for the app, persistent container for sockets |
| E2E testing | Playwright, run against production | Real browser, real assertions |
| CI/CD | GitHub Actions | One repo, one pipeline |

**Never**: a second backend framework for business logic, a second database, a second auth
provider, a paid WhatsApp bridge before you have a paying customer.

Modular monolith by default. Extract a separate service only for a demonstrated reason
(persistent WebSocket, independent scaling, fault isolation) — the WhatsApp Operator is the
canonical example: it needs a 24/7 socket, so it lives outside the serverless app.

---

## 4. Security (fail closed, always)

- **Authentication**: no secret configured → reject the request. Never "no secret? allow it."
- **Authorization**: always ask *who is this, what can they access, which tenant owns this
  resource* — derived from the database, never from client-supplied tenant IDs, webhook
  payload claims, or query parameters.
- **Multi-tenancy**: `tenant_id` on every business table, enforced at the data-access layer.
  Unscoped queries are a bug. A cross-tenant leak is a Sev-1.
- **Webhooks**: verify signature (constant-time compare) → validate payload → resolve
  ownership from trusted records → check idempotency → record the event → process → respond.
  Never cause an irreversible side effect before idempotency is established.
- **Secrets**: environment variables only, never in code, never in logs, never in a webhook URL.
- Full pre-launch list: `docs/SECURITY_CHECKLIST.md`.

---

## 5. Data & Reliability

- Prefer additive migrations (`ADD COLUMN IF NOT EXISTS`), nullable-first, backfill separately.
  Critical invariants (uniqueness, ownership) belong in the **database**, not just app code.
- Assume everything retries: webhooks duplicate, workers restart, networks time out. Use
  idempotency keys, unique constraints, `UPSERT`/`ON CONFLICT`, and the outbox pattern for any
  external side effect (`pending → processing → sent → delivered → failed`).
- The UI must never claim more certainty than the system has. `Sending / Queued / Delivered /
  Failed / Unknown` — never fabricate a green checkmark.

---

## 6. Testing Pyramid

Unit → Integration → **Seam** (proves the real route actually calls the real dispatcher) → E2E.
Playwright is the default E2E tool — install it once, don't add three more testing frameworks.
Test authentication, authorization, tenant isolation (positive *and* negative), navigation,
responsive breakpoints, console/network errors, and the golden path (the one journey that proves
the product works) on every meaningful change. Every real bug gets a permanent regression test.

---

## 7. Architecture Decision Records

Create one (`docs/adr/000X-title.md`) whenever a future engineer — or a future you — might
reasonably ask "why did we do it this way?" Database choice, auth provider, messaging
architecture, a dependency upgrade you deliberately deferred, a self-hosted-vs-managed call.

---

## 8. Open-Source Adoption

Before adding a dependency or copying a repo: what problem does it solve, is it a library vs
a full app vs infra, what's the license, is it maintained, what does it cost operationally to
run. Prefer: (1) can the existing stack already do this — don't add infra for nothing;
(2) self-host when the tool is core infrastructure, data sensitivity matters, or vendor
lock-in would hurt; (3) managed service when the operational burden exceeds the value of
owning it. Never self-host for ego.

---

## 9. Two Starting Modes

**Mode A — New application.** Discover → Architecture → G0 (security & foundation, CI, tenant
isolation) → G1 (one complete vertical slice, e.g. sign up → create resource → see result) →
G2 (edge cases, observability, runbooks).

**Mode B — Existing application.** Phase 0 is **read-only archaeology**: map the real stack,
dependencies, test coverage, and risks. Produce a Current-State Report and a migration table
(`KEEP / MIGRATE / REWRITE / REMOVE / DEPRECATE` per component, with reasons and risk). Get
explicit approval before writing a single line of migration code. Never blindly "modernize
everything" in one pass — migrate by vertical slice, deprecate the old path, then remove it.

---

## 10. Read-Only Mode

When told **READ ONLY**: inspect, search, test only if it's safe, and report evidence.
Do not modify files, install anything, commit, push, deploy, or merge. State explicitly:
`Files changed: none · Commits: none · Pushes: none`.

---

## 11. Gate Report (every gate ends with one)

See `docs/templates/GATE_REPORT.md`. It must include: objective, exact baseline (branch/SHA/
remote status), files changed, tests added, failure cases tested, a results table
(tests/typecheck/lint/build/security — pass or fail, never omitted), remaining risks, and a
verdict: **PASS / FAIL / CONDITIONAL PASS**. Never hide a failure to make the report look clean.

---

## Appendix: the one paragraph to remember

> Establish the baseline. Inspect the real architecture. Identify the failure modes. Define the
> smallest safe change. Test the business logic and the seams, not just the happy path. Prove
> failures are visible. Review the diff. Verify the commit. Verify the remote. Deploy in the
> correct order. Test the real production journey. Never let a claim stand in for evidence.
