# Travel CRM

Multi-tenant finance platform for travel agencies. React + Tailwind frontend, Express + TypeScript API, MySQL, Redis/BullMQ, Cloudflare R2.

## Local setup
```bash
# 1. DB
mysql -u root -p -e "CREATE DATABASE travelfinance CHARACTER SET utf8mb4"
# schema is applied by the migration runner (sql/migrations/*.sql, tracked in schema_migrations)

# 2. API
cd backend && cp .env.example .env     # fill DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY (openssl rand -hex 32), R2_*
npm install && npm run migrate && npm run seed && npm run dev   # seed login: demo@agency.test / DemoPass#2026

Demo agency for showing the product to a client (realistic data across every module, dates always relative to today):

```bash
npm run seed:demo            # server must be running; creates "Sunrise Travel & Tours"
npm run seed:demo -- --reset # wipe and rebuild only that agency
# logins: demo@sunrise-travel.test (admin), finance@sunrise-travel.test, agent@sunrise-travel.test — password SunriseDemo#2026
```

# 3. UI
cd ../frontend && npm install && npm run dev   # http://localhost:5173 (proxies /api -> :4000)
```

## cPanel deployment
- **API**: cPanel → Setup Node.js App → app root `backend`, startup file `dist/server.js`; run `npm run build` first. Set env vars in the UI. AutoSSL covers TLS.
- **UI**: `npm run build` in `frontend`, upload `dist/` to `public_html`; add an `.htaccess` SPA fallback and proxy `/api` to the Node app (or serve API on a subdomain and set `CORS_ORIGIN`).
- **Jobs**: with Redis run `npm run worker` as a persistent process; without Redis add cron `0 8 * * * cd ~/backend && node dist/jobs/daily.js` (reminders, overdue flip, FX refresh).
- **Stripe webhook**: `POST /api/webhooks/stripe` (event `checkout.session.completed`).
- Puppeteer needs Chromium on the VPS (`npx puppeteer browsers install chrome` + system libs).

## Key design points
- **Tenancy**: all data access goes through `Tenant` (`src/db.ts`). Raw queries must reference `agency_id` (guarded); insert/update/delete inject it. Roles are per agency via `memberships`.
- **Audit**: every `Tenant` write appends to `audit_log`; MySQL triggers block UPDATE/DELETE on it.
- **Secrets**: supplier bank details AES-256-GCM (`ENCRYPTION_KEY`), never returned by the API. Refresh tokens are hashed, rotated, HttpOnly.
- **Files**: R2 bucket is private; keys are agency-prefixed and served via signed URLs (`SIGNED_URL_TTL_SECONDS`).

## Not finished / needs your validation
- Xero/QuickBooks: OAuth connect + encrypted token refresh done; **entity sync is not implemented**.
- BACS bank file not implemented; ABA and ACH (NACHA) are first-pass — validate with your bank before live use.
- No automated tests yet; not run against a live MySQL/R2/Stripe/SendGrid. Only typecheck + frontend build were verified.
- Missing UI: invoice edit screen, instalment editor, 2FA setup screen, expenses CRUD, FX rates admin, public pay page (`/pay/:id`), integrations settings.

## Local dev notes
- With no `R2_*` credentials, files are stored in `backend/.local-storage` and served through HMAC-signed, expiring `/api/dev-files` links (disabled in production).
- PDFs need Chrome/Chromium: set `PUPPETEER_EXECUTABLE_PATH` to an installed browser or run `npx puppeteer browsers install chrome`.
- Verified locally against MySQL 9: schema + triggers, seed, all read endpoints, invoice workflow, payments, supplier runs, ABA/ACH export, reconciliation (CSV/OFX), PDF/XLSX exports, role restrictions, audit immutability.

## Accounting & ticketing layer (ported from the legacy software)
- **Chart of accounts** (`/accounts`): 19 account types (110 Cash/Bank … 420 Other Income), codes = type + 4-digit sequence (e.g. 3200021), opening Dr/Cr, Transfer Account.
- **Double-entry ledger**: every receipt, payment, journal voucher, ticket invoice and refund posts a balanced voucher (`vouchers` + `gl_entries`); unbalanced postings are rejected. Ledger, Cash/Bank Balances and Trial Balance read from it.
- **Ticket invoices**: header + per-ticket lines with the legacy fare breakdown. *Supervise* = approve and post to the ledger; *Re-Post* rebuilds the postings. Agents create tentative invoices; only Admin/Finance can supervise.
- **Receipts / Payments / Journal / Cheque Format / Refund / Ticket Search / Sale Reports / Airlines** as in the old menus. Received cheques post when cleared (*Clear Checks*).
- **Line formulas** (`computeLine` in `backend/src/routes/tickets.ts`): payable = ticket − Com Rec + WH Air + Insurance + VAT Paid; receivable = Fare Inc + Taxes Inc + PSF + Other − Discount + WH Client + VAT; profit = receivable − payable − Com Paid − Agent Amount. **These are inferred from the form layout — check them against your old software's reports and adjust.**
- Not ported yet: Shirka, Update Foreign Opening, SMS, Link Invoices, Clearance, Close All Invoices, Re-Post for refunds' hotel flows beyond basic fields, Umrah workflows beyond the query-ID field.

## Testing & migrations
- `npm run migrate` applies new `backend/sql/migrations/NNN_*.sql` files once each. Never edit an applied migration; add a new one.
- `npm test` (backend) recreates the `travelfinance_test` database (it refuses any name not ending in `_test`), runs all migrations and executes unit + integration tests (tenant isolation, role matrix, branch scope, ledger integrity, period lock, audit immutability, search). Override with `TEST_DATABASE_URL`.
- See `docs/R0_AUDIT.md` (findings) and `docs/ROADMAP.md` (status vs. the product blueprint).

## R2 — CRM, quotes, bookings
Sidebar → **Sales & Bookings**: Leads (drag between stages), Quotes (multi-option, versioned), Bookings (workspace tabs), Operations (deadline/exception view + tasks).
- Sending a quote prints a secure link once (`/q/<token>`); the client can accept, request changes or decline without an account. Set the agency minimum margin in Settings.
- Public endpoints live under `/api/public/quotes/:token` — the only unauthenticated routes besides auth and webhooks.

## Design system & themes
- **Tokens, not colours.** All colours are CSS variables in `frontend/src/index.css` (`--bg`, `--surface`, `--line`, `--fg`, `--muted`, `--accent`, `--success/warn/danger/info`, …) with a `light` and a `dark` palette, exposed to Tailwind as `bg-surface`, `text-muted`, `bg-success/15`, etc. **Never use raw colours (`text-red-400`, `#fff`) in components** — use the tokens so both themes stay correct.
- **Theme switch**: Light / Dark / System (top bar, login, public quote page). The choice is stored in `localStorage` (`tf-theme`) and applied before first paint (inline script in `index.html`) so there is no flash. Charts read resolved colours via `useChartColors()` (`src/theme.tsx`).
- **Accessibility**: both palettes meet WCAG AA text contrast (≥4.5:1) for body, muted, accent, button and status-pill pairs; visible focus rings; dialogs close on Esc; icon-only buttons have labels; `prefers-reduced-motion` respected.
- Shared building blocks live in `components/ui.tsx` (`Page`, `Table`, `Pill`, `Field`, `Modal`, `Skeleton`, `EmptyState`) and `components/Layout.tsx` (sidebar, top bar, ⌘/Ctrl+K search, Create menu). Pages are code-split.
- Print/PDF outputs (invoices, cheques, reports) are intentionally always light and unaffected by the theme.

## R3 — Finance core
Finance menu: **Overview** (AR/AP/cash, aging, reconciliation), **Client Receipts** (allocate to invoices), **Credit Notes & Refunds**, **Supplier Bills**, **Statements**. Invoice rows open a detail view (ledger status, payments, credit notes, void).
- Issue an invoice (Invoices → open → *Issue*, or *Send*) to post it; from then on correct it only with a credit note or a void (reversal).
- Existing data from before R3: Finance → Overview → **Post existing invoices** (admin, once).
- Controls live in Settings: *second-approver threshold* and *supplier bill tolerance*.
- Legacy accounting pages were renamed **Cash Receipts / Cash Payments** (general cash vouchers); invoice payments go through **Client Receipts**.

## R4 — Commissions, bank reconciliation, FX controls
- **Commissions** (Finance menu): *Month-end* (submit → approve → pay, payroll CSV), *Entries* (click for the full calculation), *Rules* (versioned; edit = new version), *Supplier commission*. Set when commission becomes payable in Settings (*Commission becomes eligible when…*).
- **Bank Reconciliation**: import a CSV/OFX statement for a bank account, Auto-match, resolve the rest (match, book a fee/difference, create a client receipt, or ignore with a reason), then *Finalise* to lock the statement. CSV needs a date and an amount (or credit/debit) column.
- **Exchange Rates**: add rates manually or via the provider job; foreign-currency documents cannot be issued without a recent rate.
- **Payment Runs** (Finance menu): pick approved supplier bills → *Validate* (bank details, outstanding amounts, no bill in two open runs) → *Submit* → a **different person approves** (toggle in Settings) → *Export* ABA/ACH/CSV. Exporting never marks anything paid: use *Record settlement* with the bank reference (or a reasoned manual confirmation) to post each payment to the ledger. Failed items go back to payable. Cancel is possible only before export.

## R5 — Client portal and payment links
- **Client Portal** (Finance menu): create an expiring link per client (full portal) or per invoice (payment link), optionally emailed. Links are random 256-bit tokens stored only as hashes; revoke any time; wrong/expired/revoked links look identical.
- Clients see issued invoices (PDF, balance, **Pay** via Stripe Checkout when configured, otherwise your bank details), confirmed trips with itinerary, quote status, receipts, and can send support requests; staff reply under *Requests*. Clients never see cost, margin or supplier data.
- Card payments are recorded by the existing Stripe webhook (idempotent), so the invoice only shows paid once Stripe confirms. Emails are logged under *Deliveries* (sent / failed / skipped when SendGrid is not configured).

## R6 — Reporting and automation
- **Reports** now show a green/red *reconciliation* bar: receivables aging vs ledger client accounts, payables aging vs ledger supplier accounts, ledger debits = credits. New: Payables Aging, Profit & Loss (ledger), Departures.
- **Automation → Exceptions**: overdue invoices/bills, unposted invoices, stale bank lines, stuck payment runs, unanswered client requests, departures with unpaid balance or no itinerary, failed emails. Rescanning is idempotent; items resolve themselves when the cause clears; acknowledge or snooze the rest.
- **Rules**: *when* (invoice overdue / quote expiring / departure / bill due) *then* (create task / email client). Each record is acted on once per rule; failures retry up to 3 times.
- **Schedules**: daily/weekly/monthly reports (CSV/Excel/PDF) emailed to team members only, file kept per run, reconciliation warnings included.
- The daily job (`npm run cron:daily` / cron) runs all of this per agency; *Run now* does the same on demand.

## R7 — Integrations
- **Integrations** (Finance menu, admin): *API keys* (scoped, shown once, stored hashed, revocable), *Webhooks* (HTTPS only, private addresses refused, HMAC-SHA256 `X-TF-Signature` over `timestamp.body`, retries at 1/5/30/120/360 min then dead-letter with manual retry), *Accounting export* (journals in Xero/QuickBooks/generic CSV, invoices, bills, payments; refuses unbalanced periods and unmapped accounts), *Imports* (CSV bookings with preview, duplicate-safe by `external_ref`).
- Public API: `Authorization: Bearer tfk_…` → `POST /api/v1/leads` (use `Idempotency-Key`), `GET /api/v1/clients`, `GET /api/v1/invoices[/:id]`; 120 req/min per key.
- Events: `invoice.issued`, `receipt.created`, `lead.created`, `quote.accepted`, `bill.approved`, `booking.imported` — written in the same transaction as the change, delivered by a loop in the API process (every 30 s).
- Not built (needs provider access/decisions): Xero/QuickBooks two-way sync, GDS/supplier APIs, bank feeds, third-party CRM sync.

## Subscription billing and plans
- **Plans** (Starter / Growth / Scale) set seats, branches, bookings per month and which features are on (automation, scheduled reports, webhooks/API…). Every new workspace gets a **14-day trial of Growth**; existing ones got 30 days.
- **Lifecycle:** trialing → *grace* (7 days, everything still works) → *suspended* (read-only: you can view and export everything, change nothing). Failed card payments: *past due* with the same 7-day grace, then suspended. Paying restores access instantly. Cancelling keeps access to the period end, then the workspace is read-only. Customers of the agency (portal/payment links) are never blocked.
- **Billing page** (admin): usage meters, plan switch (upgrade immediately and prorated; downgrade only if usage fits, effective at renewal), card/invoice portal (Stripe), cancel/resume, invoice history. Everyone sees a banner when attention is needed.
- **Going live (Stripe):** create a recurring Price per plan/interval, store the ids in `plans.stripe_price_monthly` / `stripe_price_yearly`, and point a Stripe webhook at `/api/webhooks/stripe` with events `checkout.session.completed`, `customer.subscription.updated|deleted`, `invoice.paid`, `invoice.payment_failed`. Without Stripe the app says so honestly and trials/plan switching still work.
- **Invoiced customers:** `npm run billing:grant -- <agencyId> <plan> <monthly|yearly> <YYYY-MM-DD>`.
- The daily job runs `runLifecycle()` (trial expiry, dunning, suspension, scheduled changes, reminders — each notice sent once).

## Managing records
- **Clients / Suppliers:** add, edit (all fields; supplier bank details are write-only), **Archive** (hidden from lists and pickers, history kept, restorable) or **Delete** (only when nothing refers to it — otherwise the app lists exactly what blocks it). Archived clients/suppliers can't get new bookings, invoices, quotes or bills.
- **Bookings:** Edit details (reason goes to the change log) and Delete = archive with a reason (blocked by live invoices/bills; agents may only delete their own early-stage bookings); *Deleted* tab restores.
- **Team & Branches** (Administration): add/edit/remove members (last admin protected, optional hand-over of their open work), rename/delete branches (refused while in use).

