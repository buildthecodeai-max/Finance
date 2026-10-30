# R0 — Repository audit (30 Oct 2026)

Scope: the whole repo as it stood before R1. Method: read every route/service/page, typecheck, build, grep for tenancy patterns, `npm audit`, then probe with tests.

## Architecture
React 18 + Vite + Tailwind SPA → Express 5 API (TypeScript, ESM) → MySQL (mysql2, no ORM). Multi-tenancy by `agency_id` on every business table, enforced in one place (`Tenant` in `backend/src/db.ts`). JWT access token + rotating HttpOnly refresh cookie. Files in Cloudflare R2 (local-disk fallback in dev). ~3.5k LOC, 33 tables.

## Working modules (verified by manual run + R1 tests)
Auth/2FA, agencies & roles, generic invoices (draft→sent→paid, PDF, email, Stripe link), payments & supplier runs (ABA/ACH), commissions, clients/suppliers (AES-256 bank details), reports (8, PDF/XLSX), bank reconciliation (CSV/OFX), legacy-style accounting layer (chart of accounts, ledger, receipts/payments, journal, cheques), ticket invoices, refunds, airlines, sale reports.

## Incomplete / not started (vs. blueprint)
CRM/leads/quotes, booking workspace/components/itinerary/travellers/documents/tasks, credit notes, receipt→invoice allocation across many invoices, supplier bills/AP, payment-run approval workflow, commission rule engine/versioning, FX gain/loss, customer portal, automation rules UI, exception queue, Xero/QuickBooks sync, subscription/plan entitlements, super-admin, additional roles (AP, ops, branch manager, auditor).

## Findings
| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** | Foreign-key ids in request bodies (e.g. `client_account_id`, `payable_account_id`, `airline_id`, `branch_id`, `booking_id`, `supplier_id`) were never checked against the caller's agency; six JOINs lacked `agency_id`, so another agency's account name could be returned. | **Fixed in R1** (`Tenant.ref/memberRef`, JOIN filters, tests) |
| 2 | High | Zero automated tests. | **Fixed in R1** (43 tests; `npm test`) |
| 3 | Medium | No migration framework (hand-run SQL). | **Fixed in R1** (`npm run migrate`, `schema_migrations`) |
| 4 | Medium | Cross-tenant/missing-row updates surfaced as HTTP 500, not 404. | **Fixed in R1** |
| 5 | Medium | Posted ledger history could be deleted/re-posted with no period control; settings changes unaudited. | **Fixed in R1** (period lock + reason, audited) |
| 6 | Medium | Document numbers via `COUNT(*)` reissued numbers after a delete. | **Fixed in R1** (max-suffix + test) |
| 7 | Medium | Only 4 fixed roles; no branch scoping. | Branch scope added in R1 (ticket invoices); more roles → R1b |
| 8 | Medium | Generic `invoices` module did not post to the ledger (ticket invoices did). | **Fixed in R3**: invoices post on issue; ticket invoices remain a separate ledger-posting module |
| 9 | Medium | Sent invoices were not immutable snapshots. | **Fixed in R3** (snapshot, edit lock, reversal-based void) |
| 10 | Medium | `npm audit`: 17 findings (10 high) — mostly puppeteer transitive deps (`basic-ftp`, `extract-zip`), plus `zod` <4.6.6 and `csv-parse`. Fixes need major bumps (zod 4, puppeteer). | Open → R8, needs a compatibility pass |
| 11 | Low | No rate limiting outside `/auth`; no request IDs; logs not structured. | Open → R8 |
| 12 | Low | UI: tables lack pagination/sorting/saved views; no toasts/skeletons; design tokens are Tailwind colours only. | Open → incremental |
| 13 | Info | Tenant ids are auto-increment integers (guessable); every lookup is tenant-scoped, so enumeration yields nothing, but UUIDs are recommended by the blueprint. | Open → decide before public launch |

## Found later
| # | Severity | Finding | Status |
|---|---|---|---|
| 14 | High | `getRate` silently returned 1.0 when no exchange rate existed, so a foreign-currency document would be booked 1:1 into the ledger. | **Fixed in R4** (error + dated, aged, sourced rates) |
| 15 | Medium | Concurrency: document/account numbering and "does this row exist" checks used snapshot reads inside transactions, so simultaneous requests could collide or miss each other's commits (duplicate numbers, double-matches). | **Fixed in R3/R4** (locking reads + per-agency lock; covered by concurrency tests) |

## Baseline
`tsc` clean (backend, frontend), frontend build OK, 0 tests before R1.
