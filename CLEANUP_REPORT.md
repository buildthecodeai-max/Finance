# TravelFinance Pro — Cleanup & Stabilisation Report

Scope: the 10-phase master brief. Existing application repaired in place; nothing rewritten.
Verification: backend typecheck clean · frontend typecheck + production build clean · **251/251 backend tests pass** (baseline at the start of this pass: 231 pass / 19 fail) · manual browser checks listed under Testing.

## 1. Application audit (Phase 1)

| Layer | Inventory |
|---|---|
| Backend | 27 route files, 23 services, 23 forward-only SQL migrations, background jobs (worker, daily, reminders), Express 5 + MySQL, tenant isolation enforced in application code |
| Frontend | 40 pages, React + Vite + Tailwind, lazy-routed |
| Database | 88 tables; 79 carry `agency_id`; **only 4 real foreign keys in the whole schema** (1 to `agencies`) |
| Tests | 16 files, 251 tests |

Classification of what was examined:

- **Essential, kept:** auth, tenant context, billing/plans, CRM, bookings, ticketing, finance, accounting, bank, commissions, reports, automation, integrations hub, platform console.
- **Duplicate, consolidated:** see section 3.
- **Broken, repaired:** see section 5.
- **Dead code, removed:** step-up re-authentication, the unused Ledger page.
- **Unused, verified before touching:** `commission_closes` (0 rows, 0 code references in dev) — *not* dropped, see section 8.
- **Dependent, preserved:** all billing, subscription, agency and user data.

Dependency health: **no circular imports** in backend (67 files / 331 edges) or frontend (50 files / 189 edges). No unused npm dependencies in either package. Navigation: every sidebar item has a route; no link points at a missing route.

## 2. Removed / consolidated

Removed:
- Step-up TOTP code: the `stepUp` middleware, `/platform/step-up` endpoint, `performStepUp`, the `STEP_UP_MINUTES` constant, the Operators "Last confirmation" column, and two tests. Nothing used it any more (`b0fb586` had removed it from the routes).
- `frontend/src/pages/Ledger.tsx` (orphaned after the merge).
- The empty-`catch` agency delete handler (replaced, see bugs).

Consolidated:
- Finance + Accounting sidebar sections → one **Finance & Accounting** section (module-gated on either module).
- Chart of Accounts + General Ledger → one **Accounts & Ledger** page (inline ledger per account; `/ledger` redirects).
- "Reports" listed in two sidebar sections → shown once, in the first visible section.
- Scattered `NODE_ENV === 'test'` 2FA checks → one `config.skip2fa` flag.
- Reason requirements: removed from backend routes (bank, bookings, commissions, crm, finance, invoices, admin, platform) and from 9 agency pages plus all platform modals.

## 3. Items deliberately **not** consolidated

These look like duplicates by name but have different accounting meaning; merging them is a workflow decision, not a cleanup:
- Client Receipts (allocated to invoices) vs Cash Receipts (cash vouchers).
- Payments vs Cash Payments vs Payment Runs.
- Ticketing Refunds vs Credit Notes & Refunds.
- `commissions` vs `commission_entries` — both hold 19 rows in dev, so they appear to be dual-written. Needs a data-owner review before any merge.

## 4. Super Admin control & audit (Phase 4)

- No operation requires a reason. Backend schemas accept a missing `reason` key (previously a missing key was a 400 even though the UI sent `''`). Empty reasons are stored as `NULL`.
- Audit logging is never disabled. Platform operator log now records: actor id, **actor role**, action, target agency, **before / after state** (agency edit/delete, plan edit, set plan, grant, extend trial, suspend, reactivate), timestamp, IP and **user agent**. Tenant `audit_log` additionally records actor role and user agent. Both logs stay append-only (database triggers).
- Operator audit view shows role and a before/after disclosure.

## 5. Bugs found and fixed (Phase 8)

| # | Bug | Root cause | Fix |
|---|---|---|---|
| 1 | **Deleting an agency left its data behind** | Handler deleted from ~7 tables, ran inside an empty `catch`, and silently failed on the append-only tables. ~75 tenant tables were never touched; dev DB had 174 orphaned rows | Transactional cascade driven by the schema (`tenantTables()`), keeps the 5 append-only evidence tables, removes sole-member users (never operators), rolls back and reports on any error |
| 2 | Plan edit failed with "A reason (5+ characters) is required" | `needReason()` threw on empty; the modal has no reason input | Reason optional end to end |
| 3 | 2FA/platform-2FA controls untestable | `NODE_ENV=test` bypass, and the test runner is `NODE_ENV=test`, so 6 security tests could not exercise the real control | Explicit `skip2fa` flag; tests set `ENFORCE_2FA=true` (local dev behaviour unchanged) |
| 4 | 19 failing tests | Asserted the removed mandatory-reason behaviour | Updated to the new behaviour; role checks confirmed intact (agents still blocked) |
| 5 | Row **Delete** (Clients/Suppliers) claimed "no invoices attached" for a client with 6 invoices | Confirmation rendered before the dependency check loaded (introduced by my earlier row-button change) | Waits for the check; now shows "7 bookings, 6 invoices… Archive instead" |
| 6 | React "unique key" warning on Accounts | Un-keyed fragments in a list | Keyed `Fragment` |
| 7 | Accounts page unusable on phones | Fixed 240px sidebar squeezed the table to ~100px | Stacks below `md`; type filter becomes a select; table scrolls |
| 8 | Stale doc comment claiming step-up exists | — | Corrected |

## 6. Database changes (Phase 6)

- **Migration `023_audit_context.sql`** — additive, nullable, instant (MySQL 9.7): `platform_audit_log` +`actor_role`, `before_json`, `after_json`, `user_agent`; `audit_log` +`actor_role`, `user_agent`. Applied to the dev DB. No data touched.
- **New tool `npm run db:orphans`** — reports rows whose agency no longer exists; `--apply` deletes them in one transaction (take `npm run backup` first). Never touches the append-only tables. Dev DB currently reports 174 rows (accounts 26, api_log 145, branches 1, departments 1, platform_approvals 1); **I have not applied it** — it is irreversible.
- Findings, no action needed: all 79 tenant tables have an index led by `agency_id`; `api_log` has a 90-day purge; no orphans found in any `*_id` reference other than leftovers from the old delete bug and intentional audit evidence.
- Not changed (needs production data first): `commission_closes`, `commissions`/`commission_entries` (section 3), column `users.platform_stepup_at` (now unused; dropping it is destructive for no benefit).

## 7. Permission model (Phase 5)

Hierarchy: Super Admin (platform operator, role-scoped `readonly < support < billing < admin`) → Agency Admin → Finance Manager → Agent → Viewer. Agencies cannot reach each other's data (isolation tests pass); operators enter a workspace only through audited "access workspace" or read-only support sessions.

Backend enforcement audit: every mutating tenant route carries a role guard. The only unguarded mutating routes are by design — public auth endpoints, token-authenticated public quote links, and `/tickets/calc` (pure calculation). Support sessions are blocked from all writes and from credentials.

Effective matrix (A = agency admin, F = finance manager, G = agent, V = viewer; "all" = any signed-in member; rows sharing a source file are combined):

| Mount | Write access (roles × routes) | Read access |
|---|---|---|
| `/api/accounting` | AF×9 | AFV×7, all×4 |
| `/api/admin` | A×4, AF×1 | AF×3, all×2, A×2 |
| `/api/airlines` | AF×3 | all×1 |
| `/api/automation` | AF×10 | AFV×6 |
| `/api/bank` | AF×9, A×1 | AFV×6 |
| `/api/billing` | A×6 | all×2, AF×1, A×1 |
| `/api/bookings`, `/api/travellers` | AFG×13, AF×1 | all×5, AF×1 |
| `/api/cheque-formats`, `/api/vouchers` | AF×5 | AFV×4 |
| `/api/clients`, `/api/suppliers`, `/api/team` | AF×8, A×3, AFG×2 | all×6, AFGV×1, AF×1, A×1 |
| `/api/commissions` | AF×12, A×1 | all×8, AFV×3, AF×1 |
| `/api/crm`, `/api/leads`, `/api/ops` | AFG×7 | all×5, AFGV×1 |
| `/api/finance` | AF×25, A×1 | AFV×14, AF×1 |
| `/api/hub` | A×10, AF×1 | A×5, AF×4 |
| `/api/integrations` | A×1 | all×2, A×1 |
| `/api/invoices` | AF×5, AFG×2 | all×3 |
| `/api/payments` | AF×4 | all×3, AF×1 |
| `/api/portal-admin` | AF×4 | AFV×3 |
| `/api/quotes` | AFG×5, AF×1 (+3 public token routes) | all×4 |
| `/api/tickets` | AF×7, AFG×2 (+1 calculator) | all×6, AFV×1 |
| `/api/dashboard`, `/api/reports` | — | all |

## 8. Remaining known issues / decisions for you

1. **Two-person approval for suspensions is still ON by default** (`PLATFORM_TWO_PERSON`). With a single Super Admin, "suspend" creates a pending request nobody else can approve — which contradicts "unrestricted Super Admin". I did **not** change this default because it is a security policy call. To make suspension immediate: set `PLATFORM_TWO_PERSON=false` in `backend/.env`.
2. **Apply the orphan cleanup** when ready: `npm run backup`, then `npm run db:orphans -- --apply`.
3. Agency deletion removes database rows but **not files** in object storage (logos, PDFs) belonging to the deleted agency.
4. The local-dev 2FA skip keys off `NODE_ENV=test`. Production must run with `NODE_ENV=production` (a deployment with `NODE_ENV=test` would run with 2FA off).
5. Verify `commission_closes` is empty in production before dropping it; decide the fate of the `commissions` / `commission_entries` pair.
6. Console shows two React Router v7 migration notices (informational).
7. There are no automated frontend tests; frontend verification below is manual.

## 9. Testing (Phase 9)

Automated (backend, `npm test`): login/logout, 2FA sign-in incl. single-use codes and password-reset not bypassing 2FA, operator access and role matrix, agency actions (extend, set plan, grant, suspend/reactivate, delete), plan create/edit, support sessions, two-person approvals, audit trail and its append-only guarantee, tenant isolation, billing, finance, bank, commissions, reports, portal. **251/251 pass.** New tests added: agency cascade delete (data removed, neighbour intact, users removed, audit evidence kept), reason-less requests, audit context (role, user agent, before/after).

Manual, in the running app: Accounts & Ledger inline ledger renders correct running balances; sidebar shows each destination once; Clients row Delete shows the correct dependency message; **saving a plan with no reason returns 200** (the original bug, end to end); six pages at 375px have no horizontal overflow and Accounts is usable on a phone; desktop layout unchanged.

Not exercised through the UI: deleting an agency (covered by the automated test; not run against your dev data).
