# Roadmap status vs. Product Blueprint v2.0

| Release | Status | Notes |
|---|---|---|
| R0 Audit | ✅ Done | `docs/R0_AUDIT.md` |
| R1 SaaS foundation | ✅ Core done (see below) | tenant isolation hardened + tested, branch scope, settings, period lock, audit/security viewers, global search, migrations, test suite |
| R1b | ⏭ Next | granular permissions + extra roles (AP, Ops, Branch Manager, Auditor), per-branch scope on all modules, onboarding wizard, design tokens/pagination/toasts |
| R2 CRM + bookings | ✅ Core done (gaps below) | leads + pipeline, activities, tasks, client timeline, versioned multi-option quotes with margin guardrail + secure client link, quote→booking conversion, booking workspace (components, travellers, itinerary, change log, profitability), operations deadlines |
| R3 Finance core | ✅ Core done (gaps below) | invoice posting + immutable snapshot, receipts with allocations, credit notes, client refunds (maker–checker), supplier bills/AP, aging, statements, AR/AP reconciliation, FX realised gain/loss, backfill of pre-ledger data |
| R4 Commission/controls | ✅ Done (except unrealised FX) | ✅ commission engine + month-end close, ✅ bank reconciliation against the ledger, ✅ FX rate controls & realised FX, ✅ payment-run approvals; ⏭ unrealised FX revaluation outstanding |
| R5 Customer experience | 🟡 Core done | ✅ expiring/revocable portal links, ✅ per-invoice payment links (Stripe Checkout), ✅ support requests, ✅ delivery log; ⏭ quote acceptance inside the portal, traveller-detail forms, document uploads, branded email templates, agent-created links |
| R6 Reporting + automation | 🟡 Core done | ✅ reports with built-in reconciliation (AR/AP/ledger), ✅ scheduled exports (team-only recipients), ✅ exception queue, ✅ trigger→action rules (idempotent, retried); ⏭ saved report views, report-level permissions by branch, accrual/cash mode, supplier-deposit/ticketing-deadline triggers, quiet hours & client communication preferences |
| R7 Integrations | 🟡 Provider-neutral core done | ✅ scoped API keys + public `/api/v1` (idempotent lead capture, client/invoice reads), ✅ signed webhooks (outbox, retries, dead-letter, manual retry, SSRF guard), ✅ accounting CSV export with explicit account mapping (Xero/QuickBooks journal formats), ✅ CSV booking import adapter, ✅ OAuth disconnect + health view; ⏭ **needs your provider decisions:** Xero/QuickBooks two-way sync, GDS/supplier APIs, live bank feeds, third-party CRM sync |
| Billing & plans | ✅ Built (needs Stripe products to go live) | ✅ 3 plans with seat/branch/booking limits and feature gates, ✅ 14-day trial → 7-day grace → read-only, ✅ dunning, ✅ upgrades prorated / downgrades at renewal, ✅ cancel/resume, ✅ Stripe webhooks (idempotent), ✅ manual/invoiced customers, ✅ usage meters; ⏭ storage metering, coupons, tax/VAT on subscriptions, platform-admin console |
| Platform admin console | ✅ Built | ✅ fleet overview (MRR/ARR, trials, holds), ✅ agency directory + detail, ✅ extend trial / set plan / grant invoiced access / suspend & release, ✅ plan editor, ✅ read-only support sessions visible to customers, ✅ operator audit + cross-tenant security events, ✅ CLI-only operator provisioning with mandatory 2FA; ✅ operator roles (readonly / support / billing / admin), ✅ step-up re-authentication with single-use TOTP codes; ✅ two-person approval for suspensions; ⏭ impersonation with write access (deliberately not built), two-person rule for plan/price changes |
| R8 Production readiness | 🟡 Engineering done; launch needs your sign-off | ✅ security review + 10 fixes (docs/SECURITY.md), ✅ observability (request ids, JSON logs, readiness, metrics, job heartbeats), ✅ encrypted backups + automated restore verification, ✅ performance (indexes, load test), ✅ accessibility fixes, ✅ retention purge, ✅ runbook + launch checklist, ✅ password reset by email; ⏭ real restore drill on production, external pen test, legal docs |

## R1 acceptance results
- Cross-tenant access to ticket invoices, ledger, accounts, lists, vouchers, refunds, journal: denied (404/400/403), no existence leak, security event recorded. ✅ tests
- Foreign ids in bodies rejected everywhere they're accepted. ✅ tests
- Role matrix (viewer/agent/finance/admin) enforced server-side and denials logged. ✅ tests
- Branch-scoped users cannot read, edit, supervise or list another branch's ticket invoices. ✅ tests (ticket invoices only — other modules in R1b)
- Period lock blocks posting and reversal; reopen requires Admin + reason; history append-only. ✅ tests
- Audit/security/period-lock tables append-only at DB level. ✅ tests
- Base currency frozen after first transaction. ✅ tests

## R2 acceptance results (76 backend tests in total)
- Lead → client conversion is idempotent; duplicates are flagged, never blocked; lost needs a reason. ✅
- Quotes: sent versions are immutable; editing a sent quote makes v(N+1), returns it to draft and revokes the client link; acceptance only applies to the current version. ✅
- Margin guardrail blocks sending below the agency minimum until a finance manager approves. ✅
- Public quote link: token stored hashed, expires, identical 404 for wrong/revoked/expired tokens, client view contains no cost, markup, supplier or internal notes, rate-limited. ✅
- Conversion creates exactly one booking even under concurrent requests (row lock; verified by removing the lock and watching the test fail). ✅
- Booking: booking / supplier-confirmation / ticketing / fulfilment / payment statuses are separate; every tracked change is logged with actor and reason (append-only); cancelled/closed bookings are frozen and reopened only by finance/admin with a reason. ✅
- Travellers: passport numbers AES-256 encrypted, masked everywhere, revealed only to admin/finance, each reveal logged. ✅
- Agents see only their own leads/quotes/bookings/tasks; other agencies see nothing; body-supplied foreign ids are rejected. ✅

## R2 known gaps (deliberately not built yet)
- **Documents/attachments** on bookings, travellers and quotes (needs the R2 file pipeline: type/size limits, virus scan hook, signed access, access audit).
- Branded quote **PDF** and email templates; side-by-side **version comparison** UI (versions are stored and listed, not diffed).
- Time-zone-aware itinerary rendering, rooming lists, group allocations, printable/mobile traveller itinerary.
- Round-robin lead assignment, saved views, bulk actions; consent/retention workflows for traveller data.
- Booking `payment` status is derived from the existing generic invoices module; credit notes, allocations and ledger posting for bookings arrive in R3.
- Existing 18 seed bookings predate R2 and have no components.

## R3 acceptance results (110 backend tests in total)
- Issuing an invoice posts Dr receivable / Cr revenue / Cr tax, locks the FX rate and freezes a snapshot; issued invoices cannot be edited or status-voided. ✅
- Void = reversal (never a delete); blocked once paid or credited; credit note instead. Period locks apply to issue, receipts, reversals. ✅
- Receipts are separate from allocations: one receipt → many invoices; unallocated stays as client credit; over-allocation, cross-client, cross-tenant and currency-mismatched allocations are refused; void releases allocations by reversal. ✅
- Retries and races: idempotency key (also used by Stripe/bank-import paths) → exactly one receipt; simultaneous allocations to one invoice cannot overpay it (row lock; verified by removing the lock and watching the test fail). ✅
- Credit notes capped at what is still creditable; full credit → `credited`; refunds only for genuine overpayment, reserved while pending, paid exactly once. ✅
- Maker–checker: above the agency threshold a different person must approve credit notes, refunds and supplier bills. ✅
- Supplier bills: duplicate reference rejected, same supplier/amount/date warned, per-component cost mismatch beyond tolerance blocks approval without an override reason; part-payments; void by reversal. ✅
- FX: invoice rate locked at issue and unaffected by later rate changes; realised gain/loss posted at allocation and reversed on void. ✅
- AR and AP control accounts reconcile exactly to open invoices/bills (checked after a mixed history incl. voids, credits, part-payments). ✅
- Backfill: pre-ledger invoices/payments are posted once (admin only), skipping anything inside a locked period. ✅

## R3 known gaps
- **Revenue basis**: invoices post **gross** (full selling price to *Booking Revenue*, supplier cost to *Supplier Costs* when the bill is approved). Net/agent-commission recognition for pass-through bookings is a launch decision (blueprint §22) and needs an accountant's sign-off — the posting rules are isolated in `services/finance.ts`.
- **Unrealised FX** revaluation and FX on supplier *bills* at the bill date (only realised FX on payment is posted).
- **Payment runs** are now bill-based with approval (R4); the legacy run creator is disabled (`POST /payments/runs` → 409).
- Supplier bill ↔ booking component matching exists in the API (`component_id`); the bill form in the UI does not yet offer a component picker.
- Invoices are not yet generated *from* a booking in one click; credit-note/invoice PDFs: invoices only.
- Tax is a single rate per line; jurisdiction rules/effective dates → later.
- The pre-existing ticket-invoice module remains a parallel, ledger-posting model (no change in R3).

## R4 acceptance results (161 backend tests in total)
**FX controls**
- A missing exchange rate is an error (409), never 1:1. Rates are looked up by document date (direct → inverse → via USD), must be newer than the agency's max age, and carry a source and date that are stored on the issued invoice/receipt/bill. Manual rates are audited and a >25% jump needs explicit confirmation. ✅
**Commissions**
- Versioned rules scoped by product/supplier/destination/agent/branch/date; most specific wins, then priority, then newest. Editing a rule creates a new version; calculations keep pointing at the version they used. ✅
- Fixed, %-of-selling, %-of-margin and tiered bases; overhead allocated by margin; fallbacks (supplier override → agent default) for pre-R4 setups. Every entry stores its inputs and per-line explanation. ✅
- Lifecycle Estimated → Accrued → Eligible → Approved → Paid / Reversed with a configurable eligibility trigger. ✅
- Splits sum exactly; overrides need a reason; approved/paid entries are never edited — changes become signed adjustments, cancellations become clawbacks in a later period, negative nets are carried forward not paid. ✅
- Month-end: submit → approve (second person above the threshold) posts Dr expense / Cr payable; reopen reverses it (admin + reason); pay posts Dr payable / Cr bank; payroll CSV only for approved periods. Agents see only their own. ✅
- Supplier-paid commission is tracked as a separate receivable and posted when received. ✅
**Bank reconciliation**
- Statements (CSV/OFX) per bank account with line-level dedupe; matching is against the ledger's cash entries, so receipts, bill payments, cash vouchers and refunds all reconcile. ✅
- Confidence-scored suggestions; auto-match only for a single clear winner; combined deposits and split payments supported but never automatic; bank fees/differences are booked and matched in one audited step; a deposit can become a client receipt. ✅
- Finalise requires every line resolved, the statement to add up and the bank balance to agree with the books; finalised statements are locked; reopen is admin + reason. ✅

## R4 known gaps / behaviour changes
- **Payment runs** (built): draft → validated → submitted → approved → exported → processing → paid / partially paid / failed, plus cancelled. Maker–checker (setting `dual_control_runs`, default on, plus the agency approval threshold), re-validation at every step, ABA (AUD) / ACH (USD) / CSV export that never marks anything paid, settlement per item with bank reference or a reasoned manual confirmation, failed items return to payable. Not yet: importing the bank's return file to settle automatically, SEPA/BACS formats, multi-currency runs.
- Unrealised FX revaluation, foreign-currency bank accounts (statements must be in the base currency), tax-by-jurisdiction.
- "Client type" scoping for commission rules (no client-type field exists yet). Commission PDF statements (JSON/CSV only).
- The old commission *close* and `payroll.csv` endpoints and the old `/recon/*` endpoints were **replaced** by the new ones.
- Pre-R4 bookings recalculated with the new per-line overhead allocation: on the demo data, 1,632.15 vs 1,604.88 before (+1.7%). Nothing had been approved, so no history changed.
