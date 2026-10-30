# Operations runbook

## Architecture at a glance
React SPA (static files) → Cloudflare → cPanel Node app (Express API, `dist/server.js`) → MySQL. Files in Cloudflare R2 (signed URLs). Email via SendGrid, cards via Stripe, FX via Open Exchange Rates. A **daily cron** runs reminders, exception scan, automation rules, scheduled reports, retention purge. The API process itself runs the webhook delivery loop every 30 s.

## Deploying a release
1. Announce a short maintenance window if the release has migrations.
2. `npm run backup` (and confirm it printed `encrypted`). Copy the file off the server.
3. Upload code; `cd backend && npm ci && npm run build`.
4. `npm run migrate` — migrations are additive and never edited once applied. If one fails, stop: nothing is half-applied inside a migration file only if it is a single statement; check `schema_migrations` and the error before retrying.
5. Restart the Node app (cPanel → Setup Node.js App → Restart).
6. `curl https://API_HOST/api/ready` → `{"ok":true,…}` and `migrations.latest` is the new file.
7. Build and upload the frontend (`cd frontend && npm ci && npm run build`, upload `dist/`). Purge the Cloudflare cache.
8. Smoke test: sign in, open an invoice, download a PDF, open a portal link, send a webhook test.

**Rollback:** redeploy the previous build. Migrations are backwards-compatible (additive), so the old code keeps working on the new schema. Only restore the database (below) if data was damaged.

## Required environment
See `backend/.env.example`. In production the server refuses to start unless `JWT_SECRET` (32+ random chars), `ENCRYPTION_KEY` (64 hex), https `APP_URL`/`CORS_ORIGIN`, R2 and SendGrid are configured. **Losing `ENCRYPTION_KEY` makes supplier bank details and webhook secrets unrecoverable — store it in a password manager, separately from backups.**

## Scheduled jobs
| Job | How | Schedule |
|---|---|---|
| Daily (reminders, exceptions, automation, schedules, purge, FX refresh) | cron: `0 6 * * * cd ~/app/backend && node dist/jobs/daily.js` | daily |
| Backup | cron: `30 2 * * * cd ~/app/backend && npm run -s backup` | daily |
| Restore test | cron: `0 4 * * 0 cd ~/app/backend && npm run -s backup:verify` | weekly |
| Webhook delivery | in the API process | every 30 s |

## Platform console (operators)
- Create an operator on the server: `npm run platform:admin -- grant you@company.com <role>` with role `readonly`, `support`, `billing` or `admin` (give the least that does the job; the user must exist). They sign in normally, are sent to `/platform`, and must enable 2FA before it opens. Re-run `grant` with another role to change it; `... revoke <email>` removes access immediately; `... list` shows operators and roles.
- **Suspensions need two admins.** One requests (Agencies → Request suspension), a different admin approves under *Approvals* within 24 h. Keep at least two admin operators; if you only ever have one, set `PLATFORM_TWO_PERSON=false` (and accept the trade-off). In an emergency with the second admin unavailable, add another admin via the CLI rather than disabling the rule.
- High-risk actions (suspend/release, plan and access changes, support sessions) ask for a fresh authenticator code, valid for 5 minutes. If an operator loses their authenticator, revoke and re-grant after they re-enrol 2FA.
- Typical tasks: find an agency (name or member email), extend a trial, set a plan, grant invoiced access until a date, suspend/release an agency, open a read-only support session, edit plans (changes apply to everyone on the plan), review the operator audit and cross-tenant security events.
- Use support sessions instead of asking customers for screenshots; always give a ticket reference as the reason. Customers can see who looked and why.
- Keep the operator group tiny (2–3 people) and review `platform_audit_log` monthly.

## Monitoring
- **Liveness** `GET /api/health`; **readiness** `GET /api/ready` (database, migrations, job heartbeats; HTTP 503 when the database is down). Point an uptime monitor at `/api/ready` (alert on non-200 or on any job `stale`).
- **Metrics** `GET /api/metrics` with `Authorization: Bearer $METRICS_TOKEN` (Prometheus text): request counts by class, latency buckets, webhook backlog and dead letters, open critical exceptions, memory.
- **Logs**: stdout, one JSON line per request (`rid`, status, ms, agency, user). Errors include `rid`; every error response given to a client carries the same `request_id` — ask users for it.
- **In-app**: Automation → Exceptions (failed emails, stuck runs, unreconciled items), Integrations → Health (dead-lettered webhooks), Audit and Security events pages.

Suggested alerts: `/api/ready` ≠ 200 for 2 min; 5xx ratio > 2 % for 5 min; `tf_webhook_dead` increasing; `tf_open_critical_exceptions` > 0 for 24 h; `daily_job` heartbeat stale (> 36 h); disk space for backups.

## Backups and restore
- `npm run backup` → `backups/<db>-<timestamp>.sql.gz[.enc]` + `.json` manifest (sha256, per-table row counts). Consistent snapshot (`--single-transaction`), includes triggers and routines. AES-256-GCM encryption when `BACKUP_PASSPHRASE` is set (**do set it**: backups contain personal data). Newest `BACKUP_KEEP` are kept.
- **Copy backups off the server** (R2 bucket with a different credential, or another provider). A backup on the same disk is not a backup.
- `npm run backup:verify` restores the newest backup into a scratch database and checks: checksum, row counts within the window recorded at backup time, **ledger debits = credits**, append-only audit triggers present, migration count. It exits non-zero on any problem. Run it weekly and after changing the backup setup.
- **Restore for real:** create a new empty database, `npm run backup:restore backups/<file> <new_db>` (refuses non-empty databases and the live one), point `DATABASE_URL` at it, restart, run `/api/ready`. Expect to lose at most the time since the last backup (RPO ≈ 24 h with daily backups; shorten the cron if that is too long). RTO is dominated by dump size — measure it with `backup:verify`.
- Wrong passphrase appears as `incorrect header check`; a modified file as `Checksum mismatch`.

## Incident playbooks
**Site down / 5xx spike** — `/api/ready`: database down → check MySQL/hosting, then restart app; ready but 5xx → find `request_id` in logs → the stack line shows the failing route; roll back the last release if it started with a deploy.
**Suspected account takeover** — admin: remove the membership or reset the password; sessions end within 15 min (access token) and refresh tokens are revoked by the password change. Review Security events and Audit for the user. Replay of a stolen refresh token already revokes all that user's sessions automatically.
**API key or webhook secret leaked** — Integrations → revoke the key / rotate the secret. Check `last used` and the API log for misuse.
**Portal link shared by mistake** — Client Portal → Links → Revoke.
**Ledger does not reconcile** — Reports shows a red bar or Exceptions shows `invoice_unposted`; run Finance → Post existing invoices; investigate with the audit trail. Never edit gl_entries; reverse by voucher.
**Webhook endpoint failing** — Integrations → Health; fix the receiver then *Retry* on dead deliveries (endpoints auto-disable after 25 consecutive failures).
**Customer says they are locked out / read-only** — Billing page shows why (status + banner). Payment fixed → status restores on the Stripe `invoice.paid` webhook; if the webhook is failing, check Stripe's event log and `billing_events`. For invoiced customers: `npm run billing:grant`. In an emergency, `UPDATE subscriptions SET status='active' WHERE agency_id=?` (record why in the ticket).
**Email not arriving** — Client Portal → Deliveries (sent / failed / skipped). `skipped` means SendGrid is not configured.
**Database corruption / bad data change** — restore into a *new* database (above), compare, then cut over; do not restore over production.

## Capacity notes
`npm run loadtest` seeds a scratch agency with 20,000 invoices and times the heaviest endpoints; all are < 800 ms on a laptop (largest: invoice register report ~70 ms, exception scan ~0.7 s). Re-run after schema changes. API list endpoints are capped (invoices/payments 500 rows); reports are not paginated and should be date-ranged.
