# Security review (R8)

Scope: backend API, tenancy model, authentication, public surfaces (quote/portal/payment links, `/api/v1`, webhooks), file handling, dependencies. Method: code review, automated tests (every control below has a test, and the critical ones were mutation-checked: break the control, watch a test fail), and a dependency audit. Date of review: 2026-10-30.

## Controls in place

| Area | Control | Evidence |
|---|---|---|
| Tenancy | Every query is scoped by `agency_id` through the `Tenant` class; body-supplied foreign keys are validated (`ref()`), foreign/missing ids → 400 and a `security_events` row | `isolation.test.ts` and an isolation case in every release test file |
| Authorisation | Role per agency membership (admin / finance_manager / agent / viewer), optional branch scope; maker–checker on approvals | `controls.test.ts`, per-release role matrices |
| Passwords | bcrypt cost 12, min length 10, uniform-time login | `auth.ts` |
| Brute force | per-IP limiter **and** per-account lockout (8 failures / 15 min, applies equally to unknown emails so existence is not revealed) | `r8.test.ts` |
| Sessions | 15-min JWT (HS256 pinned; `alg:none` rejected), 30-day HttpOnly + Secure + SameSite=Strict refresh cookie scoped to `/api/auth`, rotation on use, **replay of a rotated token after 30 s revokes every session for that user**, password change signs out other sessions | `r8.test.ts` |
| Password reset | Emailed single-use link (random 256-bit token stored hashed, 30-min expiry, only the newest link works); identical response for known and unknown addresses; max 3 emails/hour/account; success ends every session, clears lockouts, notifies the user and is recorded in security events; never bypasses 2FA | `password-reset.test.ts` |
| 2FA | TOTP; re-enrolling requires a current code (a stolen access token cannot switch 2FA off) | `r8.test.ts` |
| Sign-up | Disabled by default in production (`ALLOW_SIGNUP`) | `r8.test.ts` |
| Secrets | Supplier bank details and webhook secrets AES-256-GCM encrypted; API keys, portal tokens, quote tokens and refresh tokens stored only as SHA-256; shown once | `r5`, `r7` tests |
| Boot safety | In production the server refuses to start with weak/dev `JWT_SECRET`, bad `ENCRYPTION_KEY`, non-https/localhost URLs, missing R2/SendGrid, Stripe without webhook secret | `assertProductionConfig`, `r8.test.ts` |
| Transport | `helmet` headers (HSTS, nosniff, frame options), CORS pinned to one configured origin, gzip | `r8.test.ts` |
| Input | zod on every body; JSON body limit 6 MB → 413; malformed JSON → 400; SQL via parameters, identifiers whitelisted (`ident()`) | `r8.test.ts` |
| Public tokens | Random 256-bit, hashed, expiring, revocable; wrong/expired/revoked are indistinguishable; rate-limited | `r5-portal.test.ts` |
| Webhooks out | HMAC-SHA256 over `timestamp.body`; https only; private/loopback/link-local targets refused at create **and at delivery**; redirects not followed; 8 s timeout | `r7.test.ts` |
| Public API | Scoped keys, per-key rate limit, idempotency keys, no cost/margin/bank data | `r7.test.ts` |
| Exports | CSV formula injection neutralised; exports refuse unbalanced periods | `r7.test.ts` |
| Audit | Append-only `audit_log` and `security_events` (DB triggers block UPDATE/DELETE); money-moving actions record who, when, why | R1+ tests |
| Logging | One JSON line per request with ids and timings only — no bodies, query strings, headers or tokens; every error response carries a `request_id` | `observability.ts` |
| Retention | Operational tables purged on a schedule (api_log 90 d, login attempts 2 d, idempotency 7 d, delivered webhooks 30 d…); financial records, audit log and security events are never purged | `r8.test.ts` |

## Platform operator console

A separate, non-tenant API (`/api/platform/*`) and UI (`/platform`) for the people who run the service.

| Control | Detail |
|---|---|
| Who | `users.is_platform_admin`, settable **only from the server CLI** (`npm run platform:admin -- grant <email>`). No API, registration field or tenant role can set it; revocation is immediate |
| 2FA mandatory | The console refuses (403 `platform_2fa_required`) until the account has TOTP enabled |
| Invisible | Non-operators get 404, not 403 |
| Roles | `readonly` (look, audited) · `support` (+ read-only customer sessions) · `billing` (+ trials, plans, invoiced access) · `admin` (+ suspend/release). Assigned only from the server CLI; the UI hides what a role can't do and the API refuses it (403 `platform_role_forbidden`), recording every denied attempt |
| Step-up | Suspend, release, set plan, grant access, create/edit plans and open support sessions need an authenticator code entered within the last 5 minutes (`/platform/step-up`). Codes are single-use even inside their 30 s window (also enforced at sign-in), and 5 wrong codes lock step-up for 10 minutes. A stolen browser session alone cannot do these |
| Two-person rule | Suspending a customer is a *request* (HTTP 202) until a **different admin operator** approves it (with their own step-up code). Self-approval is refused, requests expire after 24 h, can be rejected (reason required) or cancelled by the requester, and two approvers racing execute it once. Requested/approved/rejected/cancelled are all audited with both identities; the other admins are emailed. Releasing a hold stays single-person (restoring access is low-risk). Single-operator installs can set `PLATFORM_TWO_PERSON=false` |
| Reasons + audit | Every mutation needs a written reason and lands in `platform_audit_log` (append-only by DB trigger). Even *viewing* an agency's members is logged |
| Support sessions | Operator opens a **read-only, single-agency, viewer-level** session (5–60 min). The customer's admins get a security event + email and can end it (Settings API `/admin/support-access`); suspension ends it automatically. Support tokens cannot reach the console and cannot change passwords or 2FA |
| Operator holds | Suspension survives card payments and the billing lifecycle until explicitly released |
| Data | The console shows names, emails, usage and billing state — never passwords, financial records, or message contents |

Tests: `platform.test.ts` (mutation-checked: read-only support sessions, mandatory 2FA, role matrix, step-up enforcement, TOTP replay protection).

## Findings fixed during R8

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | No per-account login throttle: credential stuffing from many IPs was only bounded by a shared per-IP limit | Account lockout |
| 2 | High | `POST /auth/2fa/setup` replaced the TOTP secret and switched 2FA off using only an access token | Current code required |
| 3 | High | A stolen refresh token, once rotated by the real user, could still be replayed silently | Replay detection revokes all sessions |
| 4 | Medium | Weak/dev secrets could reach production | Boot guard |
| 5 | Medium | Self-service sign-up always on | `ALLOW_SIGNUP` (off in prod) |
| 6 | Medium | JWT algorithm not pinned | HS256 only |
| 7 | Medium | Invoice and reminder emails linked to `/pay/<invoice id>` (guessable) | Tokenised payment links (R5/R6) |
| 8 | Low | No way to change or reset a password | `POST /auth/password`; email reset flow (`/auth/forgot`, `/auth/reset`) |
| 9 | Low | Malformed JSON / oversized bodies returned 500 | 400 / 413 |
| 10 | Low | Reloading any page bounced to the dashboard (two concurrent refresh calls; the second was rejected after token rotation) | In-flight refresh de-duplication |
| 11 | Perf | Missing indexes made `/clients` take 6.8 s at 20k invoices; exception scan 7 s | Indexes (migration 014), batched upserts → 20 ms / 0.7 s |

## Dependency audit (`npm audit --omit=dev`, 17 advisories)

| Package | Severity | Decision |
|---|---|---|
| `puppeteer` 22 and its transitive deps (`proxy-agent`, `basic-ftp`, `extract-zip`, `get-uri`…) | high | **Accepted, mitigated.** The advisories concern browser *download*/proxy features. We launch a locally installed Chrome (`PUPPETEER_EXECUTABLE_PATH`) on HTML we generate and escape ourselves; no user-supplied URLs are ever navigated. Upgrade to the next major when PDFs have been regression-tested on it. |
| `zod` 3.x | high | **Accepted, mitigated.** Memory exhaustion needs very large constrained collections; every array in our schemas has a `.max()` and bodies are capped at 6 MB. Zod 4 is an API-breaking migration — schedule it as a separate change. |
| `exceljs` → `uuid`, `csv-parse` | moderate | Accepted: used on outputs we generate and on admin-uploaded bank files only; track upstream. |
| `@sendgrid/*` | low | Accepted. |

Re-run `npm audit` before every release and record the result in the launch checklist.

## Known gaps (not yet built)
- SSO/SAML, device/session list, IP allow-listing.
- Data-subject export/erasure tooling (retention policy exists; per-person erasure is manual and must respect financial-record retention law).
- Web application firewall / DDoS protection — provided by Cloudflare in front of the app (see RUNBOOK).
- External penetration test — recommended before onboarding the first paying customer.
