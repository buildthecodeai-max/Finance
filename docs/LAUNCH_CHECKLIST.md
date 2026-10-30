# Launch checklist

Tick every line before onboarding the first customer. "Evidence" says where the check lives.

## Security
- [ ] `NODE_ENV=production`; server boots (the boot guard passes) — *evidence: process starts*
- [ ] `JWT_SECRET`, `ENCRYPTION_KEY` generated fresh for production and stored in a password manager
- [ ] `ALLOW_SIGNUP` set deliberately (default off)
- [ ] HTTPS everywhere; Cloudflare proxy on; HSTS preload decision made
- [ ] `npm audit --omit=dev` re-run; result compared with docs/SECURITY.md
- [ ] R2 bucket private; credentials scoped to that bucket only
- [ ] Stripe live keys + webhook secret; webhook endpoint registered at `/api/webhooks/stripe`; a live £1 payment tested and refunded
- [ ] Demo user (`demo@agency.test`) and seed data **absent** from production
- [ ] External penetration test done or consciously deferred (record who decided)

## Data safety
- [ ] `BACKUP_PASSPHRASE` set; daily backup cron installed; first backup copied off-server
- [ ] `npm run backup:verify` passes on the production database
- [ ] A real restore drill completed into a new database, with timing recorded
- [ ] Backup retention and off-site copy retention agreed

- [ ] Operators created via `npm run platform:admin`, each with 2FA and the least-privileged role; no shared operator accounts; step-up tested with a real authenticator; at least two admin operators so suspensions can be approved

## Reliability and monitoring
- [ ] Uptime monitor on `/api/ready`; alerts reach a human
- [ ] `METRICS_TOKEN` set and scraped (or consciously skipped)
- [ ] Daily cron installed; after 24 h `/api/ready` shows `daily_job` heartbeat `ok`
- [ ] SendGrid domain authenticated (SPF/DKIM); a test invoice email delivered
- [ ] Error `request_id` workflow understood by support

## Quality gates
- [ ] `npx vitest run` green (210 tests at R8) — *evidence: CI output*
- [ ] `npx tsc --noEmit` clean in backend and frontend; `vite build` succeeds
- [ ] `npm run loadtest` under 800 ms for every endpoint
- [ ] Manual pass: sign-in, invoice → issue → pay, supplier bill → payment run → settle, bank reconciliation, month-end commission close, portal link, report reconciliation bar green
- [ ] Accessibility: keyboard-only pass of sign-in, invoice list, a modal form; skip link, dialog focus trap and page titles verified (done in R8); a screen-reader pass recommended
- [ ] Mobile/tablet pass of the main flows

## Business and legal
- [ ] Terms of service, privacy policy, data-processing agreement published; sub-processors listed (Cloudflare, SendGrid, Stripe, Open Exchange Rates, hosting)
- [ ] Data retention and deletion policy agreed (see SECURITY.md → Known gaps)
- [ ] Password reset tested with a real mailbox (SendGrid live): link arrives, works once, old sessions end
- [ ] Support contact, status page and incident communication template ready
- [ ] Plan prices and limits confirmed (`plans` table); Stripe Products/Prices created and their ids stored; subscription webhook registered and a live subscribe → cancel cycle tested
- [ ] **Stripe Connect decision:** client card payments (portal/payment links) currently settle to the *platform's* Stripe account, not each agency's. Before real agencies take payments, either adopt Stripe Connect (agencies onboard their own accounts) or restrict portal card payments and use bank transfer
- [ ] Tax/VAT on subscription invoices decided (Stripe Tax or manual)

## Sign-off
| Role | Name | Date |
|---|---|---|
| Engineering | | |
| Finance owner | | |
| Security | | |
