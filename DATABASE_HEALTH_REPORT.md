# Database Health Report — TravelFinance Pro

Scope: `backend/sql/migrations/001_init.sql` through `020_archive_and_management.sql` (20 migrations), static review only — no connection to a live dataset with production-scale volume was tested.

## Summary

The schema is multi-tenant (`agency_id` on every business table), uses an append-only `audit_log` for every mutation, and has had at least one real load-test pass already (`014_r8_performance_indexes.sql` explicitly references a 20k-invoice load test). Overall health: **good**, with one structural gap (foreign keys) that is a deliberate-looking tradeoff rather than an oversight, and worth documenting explicitly if not already a conscious decision.

## Findings

**DB-1 (MEDIUM — duplicate of SECURITY_AUDIT M-2).** Only `001_init.sql` (3 occurrences) and `002_accounting.sql` (1 occurrence) use `FOREIGN KEY ... REFERENCES`. Every migration from `003_r1_foundation.sql` onward (crm/booking, finance-core, commissions/bank/fx, portal, reporting/automation, integrations, billing plans, platform admin, archive/management) adds `agency_id`/`client_id`/`supplier_id`/`booking_id`/`invoice_id` columns with **indexes but no referential-integrity constraints**.
- Consequence: the database itself cannot prevent an orphaned row (e.g. a `payments` row whose `client_id` no longer exists) or a row created with a `client_id` belonging to a different `agency_id`. The app-layer `Tenant.ref()` guard is the only thing preventing this today, and it was found to be consistently used (see API_HEALTH_REPORT).
- This is very likely intentional — composite `(agency_id, foreign_id)` validity can't be expressed as a simple single-column FK in MySQL without a matching unique composite key on the parent, and retrofitting that is nontrivial with the existing archive-not-delete soft-delete pattern (an FK would need `ON DELETE` semantics that don't apply, since rows are archived, not deleted). **Recommendation**: keep as app-layer-only, but add a short paragraph to the schema docs/README stating this explicitly, and keep the `Tenant.query` runtime guard as the enforcement mechanism (already done).

**DB-2 (LOW).** Indexing is reactive rather than planned — `014_r8_performance_indexes.sql`'s own comment says the indexes were added only after a load test surfaced full-table scans on `invoices`/`payments`/`vouchers`/`supplier_bills`/`booking_components`. Later migrations (`020_archive_and_management.sql`) do proactively add 3 indexes alongside the new `archived_at` columns, which is the right pattern going forward. No currently-missing index was identified in this static pass, but recommend re-running the load-test script (referenced in the migration comment) after any new report/list query is added, rather than waiting for it to show up as a production slowdown.

**DB-3 (INFORMATIONAL).** Financial-integrity guards exist and were spot-checked:
- `agencies.locked_through` (period lock) is checked via `Tenant.assertPeriodOpen()` before backdated postings — correct pattern for preventing retroactive edits to closed periods.
- Base currency is immutable once any GL/invoice row exists (`admin.ts` settings PUT) — prevents silently corrupting historical FX-converted figures.
- Payment/receipt creation uses an `idem_key` + transaction + `ER_DUP_ENTRY`-aware retry handling (`services/finance.ts`) to guarantee a webhook retry or double-click can't record a duplicate payment.
- Invoice numbering (`Tenant.takeInvoiceNumber()`) does a `SELECT ... FOR UPDATE` on the agency row before incrementing — correct way to avoid a race producing duplicate invoice numbers under concurrent requests.
- `Tenant.tx()` wraps writes in a real transaction with rollback on any thrown error, and is used throughout the finance-critical services (`accounting.ts`, `commissions.ts`, `finance.ts`, `payment-runs.ts`, `imports.ts`, plus the booking/invoice/voucher/ticket routes).
These were the specific items the master audit brief called out ("financial operations use appropriate transactions and prevent duplicate payment or invoice creation") — all **PASS**.

**DB-4 (NOT TESTED).** Orphaned-record sweep, actual query-plan/EXPLAIN analysis, connection-pool exhaustion behavior under concurrent load, and N+1 query patterns in list endpoints were **not tested** in this pass — doing so meaningfully requires either production-scale data or a synthetic load-test run (the repo already has `scripts/loadtest.ts` per the migration comment; recommend running it again and diffing against `014`'s findings).

## Files reviewed
`backend/sql/migrations/001_init.sql` through `020_archive_and_management.sql` (all 20 files), with full-text review of `001_init.sql` and `014_r8_performance_indexes.sql`, and FK/index grep across all 20.
