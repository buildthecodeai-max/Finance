import { pool, Tenant } from '../db.js';
import { createLink, deliver } from '../services/portal.js';
import { fmt } from '../services/money.js';
import { config } from '../config.js';
import { refreshAll } from '../services/commissions.js';
import { runAll } from '../services/automation.js';
import { runLifecycle } from '../services/billing.js';
import { heartbeat, purgeOld } from '../services/observability.js';
import { fileKey } from '../storage.js';
void fileKey;

// offset = days relative to due date: -14 (14 days before), 0 (on due date), 3, 7 (after)
export const REMINDER_OFFSETS = [-14, 0, 3, 7];

/** Idempotent: reminders_sent has a unique (invoice, offset) key, so re-running a day never double-sends. */
export async function runDaily() {
  // 1) flip sent/partially_paid past due -> overdue
  await pool.query(`UPDATE invoices SET status = 'overdue' WHERE status IN ('sent','partially_paid') AND due_date < CURDATE()`);

  await pool.query(`UPDATE quotes SET status = 'expired' WHERE status = 'sent' AND valid_until < CURDATE()`);

  // 2) reminders
  let sent = 0;
  for (const off of REMINDER_OFFSETS) {
    const [rows]: any = await pool.query(
      `SELECT i.*, c.name client_name, c.email client_email, a.name agency_name FROM invoices i
       JOIN clients c ON c.id = i.client_id AND c.agency_id = i.agency_id JOIN agencies a ON a.id = i.agency_id
       WHERE i.status IN ('sent','partially_paid','overdue') AND c.email IS NOT NULL
         AND DATEDIFF(CURDATE(), i.due_date) = ?
         AND NOT EXISTS (SELECT 1 FROM reminders_sent r WHERE r.agency_id = i.agency_id AND r.invoice_id = i.id AND r.offset_days = ?)`, [off, off]);
    for (const inv of rows) {
      const when = off < 0 ? `is due in ${-off} days` : off === 0 ? 'is due today' : `is ${off} days overdue`;
      const jt = new Tenant(inv.agency_id, { userId: null, ip: 'job' });
      const link = await createLink(jt, { client_id: inv.client_id, scope: 'invoice', invoice_id: inv.id, days: 30 }).catch(() => null);   // tokenised link, never a guessable id
      await deliver(jt, { kind: 'reminder', ref_table: 'invoices', ref_id: inv.id, to: inv.client_email, subject: `Reminder: invoice ${inv.number} ${when}`,
        html: `<p>Hi ${inv.client_name},</p><p>Invoice <b>${inv.number}</b> from ${inv.agency_name} ${when}. Balance: <b>${fmt(inv.total - inv.amount_paid, inv.currency)}</b>.</p>${link ? `<p><a href="${link.url}">View and pay online</a></p>` : ''}` });
      await new Tenant(inv.agency_id, { userId: null, ip: 'job' }).insert('reminders_sent', { invoice_id: inv.id, offset_days: off });
      sent++;
    }
  }
  // keep commission lifecycle current (payment/travel triggers change without anyone touching the booking)
  const [ags]: any = await pool.query('SELECT id FROM agencies');
  for (const a of ags) await refreshAll(new Tenant(a.id, { userId: null, ip: 'job' })).catch(() => {});
  await runAll().catch((e) => console.error('[automation]', e));   // exception scan, automation rules, scheduled reports
  const billing = await runLifecycle().catch((e) => { console.error('[billing]', e); return null; });
  const purged = await purgeOld().catch((e) => { console.error('[purge]', e); return null; });
  await heartbeat('daily_job', `sent=${sent}`);
  return { sent, purged, billing };
}
