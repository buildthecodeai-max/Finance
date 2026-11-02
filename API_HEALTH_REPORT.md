# API Health Report — TravelFinance Pro Backend

Scope: inventory of `backend/src/routes/*.ts` mounted in `app.ts`, with auth/validation/error-handling spot checks. Static review + live checks against `http://localhost:4000`.

## Mounting / route table (`app.ts`)

Public (no `authenticate`): `/api/health`, `/api/ready`, `/api/metrics` (token-gated), `/api/dev-files` (dev-only, HMAC-signed), `/api/auth/*` (rate-limited 50/15min), `/api/integrations` (OAuth callback), `/api/public/portal`, `/api/v1` (separate API-key auth, see below), `/api/platform/*` (separate operator auth + rate limit), `/api/public/quotes` (token-authenticated), `/api/webhooks/stripe` (signature-verified).

Authenticated (`authenticate` + `subscriptionGuard` on the `/api` router): billing, dashboard, invoices, clients, suppliers, bookings, team, payments, commissions, reports, bank, integrations, accounting, airlines, vouchers, cheque-formats, tickets, admin, finance, portal-admin, automation, hub, travellers, leads, crm, ops, quotes.

**Verified live**: unauthenticated request to any `/api/*` route under the `api` router → `401 {"error":"Missing token"}`. Confirmed on `/api/clients`. **PASS.**

## Per-area findings

### `/api/auth` (routes/auth.ts)
- `POST /register` — gated by `config.allowSignup`; validates with zod (`password.min(10)`); transactional (agency+user+membership insert, rollback on failure); seeds chart of accounts + starts trial after commit. **Endpoint correctness: PASS.**
- `POST /login` — validated, rate-limited both per-IP and per-account, 2FA-aware, generic error on bad credentials. **PASS.**
- `POST /refresh` — rotating token, replay-detection. **PASS.**
- `POST /logout`, `/forgot`, `/reset`, `/password`, `/2fa/setup`, `/2fa/enable` — all validated with zod, consistent error shapes. **PASS.**
- No explicit `GET /api/auth/me`-style endpoint found separate from what `/login`/`/refresh` return (`session()` helper) — not a defect, just noting the pattern (client gets user+agencies on every login/refresh response rather than a dedicated endpoint).

### `/api/clients`, `/api/suppliers`, `/api/team` (routes/parties.ts)
- Full CRUD present: list (with `archFilter` active/archived/all), get-by-id, create, update, archive/restore, usage (dependents-before-delete), hard delete. Role gates: writes require `WRITERS` (admin/finance_manager) or `ALL_EDITORS` depending on sensitivity. **PASS.**
- Supplier bank details: never returned in list/raw form (`stripBank`), only a `has_bank_details` flag + last-4 digits, and the last-4 reveal itself is role-gated to admin/finance_manager. **PASS — good sensitive-data handling.**
- `teamRouter.post('/')`: validates `branch_id` via `t.ref('branches', ...)` before use, checks seat limit (`assertWithinLimit`) before creating a membership — correctly ordered (validate → limit-check → mutate). **PASS.**
- `teamRouter.delete('/:id')` → `removeMember()` service: protects sole admin and self-removal (per earlier session's mutation testing). **PASS.**

### `/api/platform/*` (routes/platform.ts)
Full inventory: `/me`, `/step-up`, `/operators`, `/overview`, `/system`, `/agencies` (+`/:id`, `/extend-trial`, `/set-plan`, `/grant`, `/suspend`, `/reactivate`, `/support-session`), `/approvals` (+`/:id/approve|reject|cancel`), `/support-sessions/:id/revoke`, `/plans` (+`/:id`), `/audit`, `/security-events`. All zod-validated; sensitive mutations require `needs(cap)` (capability check) and `stepUp`. **PASS** — see SECURITY_AUDIT.md for the auth-layer detail.

### Reports / Finance / Accounting (routes/reports.ts, finance.ts, accounting.ts)
- Balance/outstanding queries consistently join through `agency_id` on both sides of the join (`c.agency_id = a.agency_id`), not just the root table — this is the correct pattern for avoiding a cross-tenant join leak via a shared `account_id`. **PASS.**
- Aging reports (`finance.ts`) use parameterized bucket SQL with `BALANCE_SQL`/`BUCKETS` constants, not user input. **PASS.**

### Admin (routes/admin.ts)
- `/settings` PUT: base-currency change is blocked once any GL/invoice activity exists (financial-integrity guard), audited with reason. **PASS.**
- `/period-locks`: reopening a locked period requires `role === 'admin'` specifically (not just finance_manager), reason required, audited. **PASS.**
- `/search`: role-aware (agent sees only own ticket invoices/passengers via `AND i.created_by = ?`), branch-aware, LIKE-wildcard input is escaped (`q.replace(/[\\%_]/g, ...)`) before being embedded in a `LIKE` pattern — correct escaping, prevents a user from injecting `%`/`_` wildcards to broaden their own search beyond intent. **PASS.**

### Webhooks (routes/webhooks.ts)
- Stripe signature verified on raw body before any processing; idempotency key = Stripe session id prevents duplicate payment recording on retry. **PASS.**

## Issues found

**API-1 (MEDIUM, ties to SECURITY_AUDIT M-1):** No rate limiting on any authenticated business route — only `/api/auth` and `/api/platform` are throttled. Recommend a general per-user limiter on the main `/api` router.

**API-2 (LOW):** Raw `pool.query` calls (bypassing the `Tenant` guard) exist in 8 route files: `admin.ts` (2), `auth.ts` (32 — expected, pre-tenant-context), `automation.ts` (1), `billing.ts` (5), `bookings.ts` (1), `parties.ts` (2), `platform.ts` (3, expected — platform console is intentionally not tenant-scoped), `quotes.ts` (1). Reviewed the non-auth/non-platform occurrences: all either (a) write `security_events`/`audit_log` rows with an explicit `agency_id` param already validated upstream, or (b) are genuinely cross-tenant-safe lookups (e.g. `SELECT id FROM users WHERE email = ?` in `teamRouter.post('/')`, needed before a membership can be created). **No actual isolation bug found**, but flagging the pattern as a maintainability/defense-in-depth risk: a future raw `pool.query` added carelessly in one of these files would not get the `Tenant.query` agency_id guard. Recommend a lightweight lint rule or code-review checklist item: "new queries in `routes/*.ts` must go through `Tenant`, not `pool`, unless writing to a global table (`users`, `security_events`, `audit_log`, `login_attempts`)."

**API-3 (NOT TESTED):** Pagination/sorting/export behavior under large datasets wasn't load-tested in this pass (no large dataset present in dev). `014_r8_performance_indexes.sql`'s comment ("found missing by scripts/loadtest.ts (20k invoices)") indicates this was tested before and a load-test script exists — worth re-running if schema has changed since.

**API-4 (NOT TESTED):** `/api/v1` (external integration API, API-key authenticated per `routes/v1.ts`) and `/api/public/quotes` (client-facing token-authenticated portal) were inventoried but not exercised end-to-end with real tokens in this pass — recommend a follow-up pass specifically on these two public-surface routers, since they're the most externally exposed.

## Files reviewed
All files in `backend/src/routes/` (29 files) via directory listing + targeted reads of `auth.ts`, `parties.ts`, `platform.ts`, `admin.ts`, `webhooks.ts`; grep sweep for `pool.query` and template-literal SQL across the remainder.
