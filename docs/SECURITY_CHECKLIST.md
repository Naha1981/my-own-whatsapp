# Pre-Launch Security Checklist

Run this before any production launch, and again before any enterprise (bank/government/
insurer/telco) go-live.

1. All API keys and secrets are in environment variables — none in code, none in git history.
2. `git log -p` / secret-scan the repo before making it public or handing it over.
3. Tenant isolation enforced at the data-access layer (`tenant_id` on every business table);
   automated cross-tenant leak tests exist and run in CI.
4. Sensitive data encrypted at rest and in transit.
5. Authentication is server-side (never `if (user.role === 'admin') showButton()` alone).
6. Every record access is scoped by `tenant_id` / ownership, verified against the database.
7. All inputs validated with a schema (Zod or equivalent) — never trust client-shaped data.
8. Session cookies are secure, httpOnly, sameSite-appropriate.
9. Rate limiting on login, signup, password reset, and any expensive endpoint.
10. Bot protection (Turnstile/reCAPTCHA) on public forms.
11. Parameterized queries only — never string-concatenated SQL.
12. All user input validated server-side, not just client-side.
13. User-generated content is escaped/sanitized before render.
14. File uploads: type/size restricted, scanned or sandboxed, never executed.
15. API responses trimmed — no accidental over-fetching of internal fields.
16. Security headers set (CSP, HSTS, X-Frame-Options, etc.).
17. HTTPS enforced everywhere, including internal service-to-service calls.
18. Dependencies scanned for known vulnerabilities (Dependabot/`npm audit` or equivalent).
19. Every webhook signature is verified with a constant-time comparison; unsigned/invalid
    webhooks are rejected, not logged-and-ignored-then-processed-anyway.
20. Structured audit logging exists for every consequential action (who, what, when, which
    tenant), with no secrets or full payloads written to logs.

For regulated clients (banks, government, insurers): also confirm POPIA/GDPR data-flow mapping,
retention policy, breach-notification process, and that legal/compliance has signed off on data
residency and third-party processors before go-live.
