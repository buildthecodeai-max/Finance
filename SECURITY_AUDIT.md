# Security Audit — TravelFinance Pro Backend

Scope: static review of `backend/src` + migrations, and live black-box checks against the dev server at `http://localhost:4000`. Read-only; no code changed, no destructive requests made.

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 2 |
| LOW | 2 |
| INFORMATIONAL | 2 |
| PASS (verified secure) | 13 |
| NOT TESTED / BLOCKED | 3 |

Overall: this backend is unusually well-hardened for its stage. Tenant isolation is centralized and enforced at the data-access layer (not ad hoc per-route), auth has real brute-force protection, refresh-token rotation and theft detection, 2FA, and the platform operator console has step-up re-auth and two-person suspension approval already implemented. No SQL injection, no stack-trace leakage, no missing security headers were found.

---

## PASS — Verified secure

1. **SQL injection** — `backend/src/db.ts`. All table/column names that enter a template literal go through `ident()` (`/^[a-z_][a-z0-9_]*$/` whitelist, throws otherwise); all values are passed as `?` bind params via `mysql2`. Every `${...}` found in a route/service template literal is either a bound-safe static SQL fragment (conditional `WHERE`/`ORDER BY` clauses) or output of `ident()`/`BALANCE_SQL` constants — grepped across `src/routes`, `src/services`, none take raw user input directly into SQL text. **PASS.**
2. **Tenant isolation enforcement** — `Tenant.query()` (`db.ts:34-38`) throws `Error('Tenant.query requires an agency_id predicate')` if the SQL string doesn't mention `agency_id` — a structural guard against a dev forgetting the WHERE clause, not just a convention. `insert/update/remove/get` all inject/require `agency_id`. **PASS.**
3. **IDOR / cross-tenant FK references** — `Tenant.ref()` validates any client-supplied foreign id belongs to the caller's agency before use, and deliberately returns the same error for "foreign" and "nonexistent" (no existence-leak), logging a `foreign_reference_denied` security event. `refActive()` additionally blocks attaching archived clients/suppliers to new work. Confirmed used in `parties.ts`, `teamRouter.post('/')` (branch_id), etc. **PASS.**
4. **Auth: password storage** — bcrypt cost 12 (`auth.ts` routes), never logged or returned. **PASS.**
5. **Auth: login timing/enumeration** — `routes/auth.ts:73` always runs `bcrypt.compare` against a fixed dummy hash when the user doesn't exist, to keep timing uniform; `/forgot` always returns the same generic message and isn't awaited-blocking on the email send. **PASS.**
6. **Brute force protection** — per-IP rate limit on `/api/auth/*` (50/15min) *and* a separate per-email-hash lockout (8 failed attempts/15 min) in `login` — defeats distributed credential stuffing across many IPs, which a pure per-IP limiter would miss. **PASS.**
7. **Refresh token handling** — random 48-byte token, only the SHA-256 hash stored, httpOnly+secure(prod)+sameSite=strict cookie scoped to `/api/auth`, rotated on every refresh, and reuse of an already-rotated token revokes *all* sessions for that user (theft detection via replay). **PASS.**
8. **2FA (TOTP)** — secret encrypted at rest (`crypto.ts`), re-enrollment requires a valid current code (prevents a stolen access token from silently disabling 2FA), support-session tokens (`sup` claim) are explicitly barred from `/2fa/*` and `/password`. **PASS.**
9. **Access token lifetime** — 15 minutes (`auth.ts: signAccess`), short-lived by design; long-lived session is the httpOnly refresh cookie only. **PASS.**
10. **Platform operator console** — separate auth path (`P.platformAuth`), rate-limited (120/min), step-up re-auth (`P.stepUp`) required before `set-plan`, `grant`, `suspend`, `support-session`, `plans` write ops; two-person approval workflow for suspension (`config.platformTwoPerson`, `requestSuspend`/`approveSuspend`); every view/action audited (`P.audit`), including merely viewing an agency's member emails. **PASS.**
11. **Support sessions** — scoped to one agency, GET/HEAD/OPTIONS only (enforced in `authenticate()`, `auth.ts:36`), time-boxed, and the *customer* can see and revoke them (`admin.ts:/support-access`). **PASS.**
12. **Security headers / CSP / HSTS** — confirmed live via curl: `helmet()` is active, `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` all present; CORS locked to the single configured origin with credentials. **PASS.**
13. **Error handling / information disclosure** — confirmed live: unauthenticated request → generic `{"error":"Missing token","request_id":...}`, no stack trace; the global error handler (`app.ts:115-122`) only forwards `HttpError.message` (developer-authored) and otherwise returns a flat `Internal error` while logging server-side. No endpoint observed leaking internals. **PASS.**

## MEDIUM

**M-1. No rate limiting on authenticated business endpoints.**
Rate limiting (`express-rate-limit`) is applied only to `/api/auth/*` and `/api/platform/*`. Every other authenticated route under `/api` (clients, invoices, payments, reports, exports, search...) has no per-user/per-IP throttle.
- *Impact*: a compromised or malicious session token (or a buggy frontend retry loop) can hammer expensive endpoints (e.g. `admin.ts:/search`, `reports.ts`) with no backpressure; also no defense against a legitimate user's automation script accidentally DoS-ing their own agency's DB connections (pool is capped at 10).
- *Fix*: add a moderate global rate limiter (e.g. 300–600 req/min per authenticated user, keyed on `req.ctx.userId`) ahead of the `api` router in `app.ts`, with a stricter limit on heavy endpoints (reports/exports/search).

**M-2. Early-schema tables lack `FOREIGN KEY` constraints.**
`sql/migrations/003_r1_foundation.sql` through `012_r7_integrations.sql` (CRM/booking/finance-core/commission/bank-fx/portal/reporting/integrations) define `agency_id`/`client_id`/`supplier_id`/`booking_id` columns with indexes but **no `FOREIGN KEY ... REFERENCES`** (only `001_init.sql` and `002_accounting.sql` have any). Isolation/validity is enforced entirely at the application layer via `Tenant.ref()`.
- *Impact*: if any code path ever writes directly via `pool.query()` instead of `Tenant`/`tx` (a few exist — see API_HEALTH_REPORT §"Raw pool.query in route files"), nothing in the database itself prevents an orphaned or cross-tenant row. This is a defense-in-depth gap, not an active exploit — no such unguarded write was found in this review.
- *Fix*: either add FKs retroactively (needs a careful migration + review of ON DELETE behavior given the archive-not-delete pattern) or explicitly document the app-layer-only isolation decision and keep a lint/test rule that forbids `pool.query` writes outside `Tenant`.

## LOW

**L-1. `platformRouter.get('/agencies/:id')` is not rate-limited beyond the console-wide 120/min, and reading it is logged but not step-up gated** (`platform.ts:22`). Reading member emails across all agencies requires only the base operator role, no step-up. Given it's already fully audited and requires authenticated operator access, this is low risk but inconsistent with the step-up-for-sensitive-reads pattern used elsewhere in the platform console.
- *Fix*: optional — require `P.stepUp` for `/agencies/:id` too, or explicitly document why view access doesn't need it.

**L-2. `config.ts: assertProductionConfig`** correctly refuses to boot in prod with a weak `JWT_SECRET`/missing `ENCRYPTION_KEY`/http `APP_URL`, but this check is only invoked from `server.ts` — confirm (not verified in this pass, see BLOCKED below) that it is actually called before `app.listen` on every boot path, including any alternate entrypoint used by the cPanel "Setup Node.js App" deployment.

## INFORMATIONAL

- **I-1.** `storage.ts` dev-local fallback (`/api/dev-files`) is explicitly gated by `!config.isProd`, uses HMAC-signed, expiring, path-traversal-checked (`!key.includes('..')`) links. Fine for dev; confirm this route genuinely never mounts in production (it's conditional on `useLocal && !config.isProd`, which is correct as written).
- **I-2.** Stripe webhook (`routes/webhooks.ts`) correctly verifies signature on raw body before parsing, and uses `idem_key: stripe:<session_id>` to prevent double-recording a payment on webhook retry/replay. **PASS**-quality finding, noted here only because it's the one "integration security" item explicitly in scope.

## NOT TESTED / BLOCKED

- **Second-tenant IDOR dynamic test**: I could not create or obtain credentials for a second agency/tenant in this session, so a live cross-tenant data-access attempt (e.g. authenticate as Agency A, request an Agency B record's numeric ID) was not performed. Static review of `Tenant.ref()`/`Tenant.query()`'s structural guard gives high confidence, but this is **NOT TESTED** dynamically. Recommend: run this once two demo tenants exist.
- **CSRF**: cookies are `sameSite: 'strict'`, which is a strong CSRF mitigation for the refresh-token cookie, and all state-changing API calls require a `Bearer` access token (not cookie-driven), which removes most CSRF surface by design. No explicit CSRF token scheme exists, but given the architecture (bearer-token API, strict-SameSite cookie only used for refresh) this is **PASS by design**, not **NOT TESTED** — noting here for completeness since the master checklist asks for it explicitly.
- **Dependency vulnerability scan** (`npm audit` / Snyk-equivalent) was not run in this pass — **BLOCKED**, out of scope for this fork; recommend running `npm audit` in backend/ and frontend/ separately and triaging results.

## Files reviewed
`backend/src/app.ts`, `auth.ts`, `db.ts`, `config.ts`, `storage.ts`, `crypto.ts`, `errors.ts`, `routes/auth.ts`, `routes/platform.ts`, `routes/admin.ts`, `routes/webhooks.ts`, `routes/parties.ts`, plus grep sweeps of all `routes/*.ts` and `services/*.ts` for raw SQL and `pool.query` usage, and `sql/migrations/001–020`.
