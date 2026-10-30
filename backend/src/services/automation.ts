import { entitlements } from './billing.js';
import { HttpError } from '../errors.js';
import { Tenant, pool } from '../db.js';
import { deliver } from './portal.js';
import { addDays, fmt, r2, today } from './money.js';
import { buildReport } from '../routes/reports.js';
import { putFile, fileKey } from '../storage.js';
import ExcelJS from 'exceljs';
import { htmlToPdf, tableHtml, esc } from './pdf.js';

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const system = (agencyId: number) => new Tenant(agencyId, { userId: null, ip: 'automation' });

/* =============================================================== exception queue */
export interface Found { kind: string; ref_table: string; ref_id: number; severity: 'info' | 'warn' | 'critical'; title: string; detail?: string; amount?: number }

/** Every detector is a read-only query describing something a human should look at. */
export async function detect(t: Tenant): Promise<Found[]> {
  const a = t.agencyId, out: Found[] = [];
  const q = (sql: string, p: any[] = []) => t.query(sql, [a, ...p]);
  for (const r of await q(`SELECT i.id, i.number, c.name, DATEDIFF(CURDATE(), i.due_date) days, (i.total-i.amount_credited-i.amount_paid) bal, i.currency FROM invoices i JOIN clients c ON c.id = i.client_id AND c.agency_id = i.agency_id
    WHERE i.agency_id = ? AND i.status IN ('sent','partially_paid','overdue') AND i.total-i.amount_credited-i.amount_paid > 0.005 AND DATEDIFF(CURDATE(), i.due_date) > 30`))
    out.push({ kind: 'invoice_overdue', ref_table: 'invoices', ref_id: r.id, severity: r.days > 60 ? 'critical' : 'warn', title: `${r.number} is ${r.days} days overdue`, detail: `${r.name} owes ${fmt(r.bal, r.currency)}`, amount: r2(r.bal) });
  for (const r of await q(`SELECT i.id, i.number FROM invoices i WHERE i.agency_id = ? AND i.voucher_id IS NULL AND i.status IN ('sent','partially_paid','paid','overdue','credited')`))
    out.push({ kind: 'invoice_unposted', ref_table: 'invoices', ref_id: r.id, severity: 'critical', title: `${r.number} is issued but not in the ledger`, detail: 'Run Finance → Post existing invoices' });
  for (const r of await q(`SELECT b.id, b.bill_no, s.name, DATEDIFF(CURDATE(), b.due_date) days, b.total-b.amount_paid bal, b.currency FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id AND s.agency_id = b.agency_id
    WHERE b.agency_id = ? AND b.status IN ('approved','partially_paid') AND b.due_date < CURDATE() AND b.total-b.amount_paid > 0.005`))
    out.push({ kind: 'bill_overdue', ref_table: 'supplier_bills', ref_id: r.id, severity: r.days > 14 ? 'critical' : 'warn', title: `Bill ${r.bill_no} to ${r.name} is ${r.days} days past due`, detail: fmt(r.bal, r.currency), amount: r2(r.bal) });
  for (const r of await q(`SELECT id, tx_date, amount, description FROM bank_transactions WHERE agency_id = ? AND status = 'unmatched' AND tx_date < DATE_SUB(CURDATE(), INTERVAL 14 DAY) ORDER BY tx_date LIMIT 100`))
    out.push({ kind: 'bank_unmatched', ref_table: 'bank_transactions', ref_id: r.id, severity: 'warn', title: `Bank line from ${String(r.tx_date).slice(0, 10)} still unmatched`, detail: String(r.description ?? '').slice(0, 200), amount: r2(r.amount) });
  for (const r of await q(`SELECT id, status, total, currency, COALESCE(submitted_at, exported_at) since FROM payment_runs WHERE agency_id = ? AND kind = 'bills'
    AND ((status = 'submitted' AND submitted_at < DATE_SUB(NOW(), INTERVAL 2 DAY)) OR (status IN ('exported','processing') AND exported_at < DATE_SUB(NOW(), INTERVAL 3 DAY)))`))
    out.push({ kind: 'run_stuck', ref_table: 'payment_runs', ref_id: r.id, severity: 'warn', title: r.status === 'submitted' ? `Payment run #${r.id} awaiting approval for 2+ days` : `Payment run #${r.id} exported but not settled for 3+ days`, amount: r2(r.total) });
  for (const r of await q(`SELECT r.id, r.receipt_no, r.unallocated, r.currency, c.name FROM receipts r JOIN clients c ON c.id = r.client_id AND c.agency_id = r.agency_id WHERE r.agency_id = ? AND r.status = 'posted' AND r.unallocated > 0.005 AND r.receipt_date < DATE_SUB(CURDATE(), INTERVAL 7 DAY)`))
    out.push({ kind: 'receipt_unallocated', ref_table: 'receipts', ref_id: r.id, severity: 'info', title: `Receipt ${r.receipt_no} has ${fmt(r.unallocated, r.currency)} unallocated`, detail: r.name, amount: r2(r.unallocated) });
  for (const r of await q(`SELECT r.id, r.subject, c.name FROM support_requests r JOIN clients c ON c.id = r.client_id AND c.agency_id = r.agency_id WHERE r.agency_id = ? AND r.status = 'open' AND r.created_at < DATE_SUB(NOW(), INTERVAL 2 DAY)`))
    out.push({ kind: 'support_open', ref_table: 'support_requests', ref_id: r.id, severity: 'warn', title: `Client request unanswered 2+ days: ${r.subject}`, detail: r.name });
  for (const r of await q(`SELECT b.id, b.reference, b.destination, b.travel_start,
      (SELECT COUNT(*) FROM itinerary_items x WHERE x.agency_id = b.agency_id AND x.booking_id = b.id) legs,
      COALESCE((SELECT SUM((i.total-i.amount_credited-i.amount_paid)*i.fx_rate) FROM invoices i WHERE i.agency_id = b.agency_id AND i.booking_id = b.id AND i.status IN ('sent','partially_paid','overdue')),0) due
      FROM bookings b WHERE b.agency_id = ? AND b.status IN ('confirmed','ticketed','in_service') AND b.travel_start BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)`)) {
    if (r.due > 0.005) out.push({ kind: 'departure_unpaid', ref_table: 'bookings', ref_id: r.id, severity: 'critical', title: `${r.reference} departs ${String(r.travel_start).slice(0, 10)} with an unpaid balance`, detail: r.destination ?? undefined, amount: r2(r.due) });
    if (!r.legs) out.push({ kind: 'departure_no_itinerary', ref_table: 'bookings', ref_id: r.id, severity: 'warn', title: `${r.reference} departs ${String(r.travel_start).slice(0, 10)} with no itinerary`, detail: r.destination ?? undefined });
  }
  for (const r of await q(`SELECT id, quote_no, valid_until FROM quotes WHERE agency_id = ? AND status = 'sent' AND valid_until BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 3 DAY)`))
    out.push({ kind: 'quote_expiring', ref_table: 'quotes', ref_id: r.id, severity: 'info', title: `Quote ${r.quote_no} expires ${String(r.valid_until).slice(0, 10)}` });
  for (const r of await q(`SELECT id, kind, recipient, error FROM delivery_log WHERE agency_id = ? AND status = 'failed' AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`))
    out.push({ kind: 'delivery_failed', ref_table: 'delivery_log', ref_id: r.id, severity: 'warn', title: `Email (${r.kind.replace('_', ' ')}) to ${r.recipient} failed`, detail: r.error ?? undefined });
  return out;
}

/** Upsert findings; anything no longer detected resolves itself. Idempotent — running twice changes nothing. */
export async function scanExceptions(t: Tenant) {
  const found = await detect(t), now = nowSql(), keys = new Set(found.map((f) => `${f.kind}|${f.ref_table}|${f.ref_id}`));
  const known = new Set((await t.query('SELECT kind, ref_table, ref_id FROM exceptions WHERE agency_id = ?', [t.agencyId])).map((e: any) => `${e.kind}|${e.ref_table}|${e.ref_id}`));
  let created = 0;
  for (let i = 0; i < found.length; i += 500) {   // multi-row upserts: 20k findings must not mean 20k round trips
    const chunk = found.slice(i, i + 500);
    await pool.query(
      `INSERT INTO exceptions (agency_id, kind, ref_table, ref_id, severity, title, detail, amount, status, first_seen, last_seen) VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?, 'open', ?, ?)").join(',')}
       ON DUPLICATE KEY UPDATE severity = VALUES(severity), title = VALUES(title), detail = VALUES(detail), amount = VALUES(amount), last_seen = VALUES(last_seen),
         resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END,
         status = CASE WHEN status = 'resolved' THEN 'open' WHEN status = 'snoozed' AND snoozed_until <= CURDATE() THEN 'open' ELSE status END`,
      chunk.flatMap((f) => [t.agencyId, f.kind, f.ref_table, f.ref_id, f.severity, f.title.slice(0, 250), f.detail?.slice(0, 500) ?? null, f.amount ?? null, now, now]));
    for (const f of chunk) if (!known.has(`${f.kind}|${f.ref_table}|${f.ref_id}`)) created++;
  }
  const live: any[] = await t.query(`SELECT id, kind, ref_table, ref_id FROM exceptions WHERE agency_id = ? AND status <> 'resolved'`, [t.agencyId]);
  const gone = live.filter((e) => !keys.has(`${e.kind}|${e.ref_table}|${e.ref_id}`)).map((e) => e.id);
  if (gone.length) await pool.query(`UPDATE exceptions SET status = 'resolved', resolved_at = ? WHERE agency_id = ? AND id IN (${gone.map(() => '?').join(',')})`, [now, t.agencyId, ...gone]);
  return { open: found.length, new: created, resolved: gone.length };
}

export async function setExceptionState(t: Tenant, id: number, action: 'acknowledge' | 'snooze' | 'reopen', o: { days?: number; note?: string }) {
  const e = await t.get('exceptions', id);
  if (!e) throw new HttpError(404, 'Exception not found');
  if (e.status === 'resolved') throw new HttpError(409, 'Already resolved — the underlying condition has cleared');
  const patch = action === 'acknowledge' ? { status: 'acknowledged', note: o.note ?? null } : action === 'snooze' ? { status: 'snoozed', snoozed_until: addDays(today(), o.days ?? 3), note: o.note ?? null } : { status: 'open', snoozed_until: null };
  await t.update('exceptions', id, { ...patch, handled_by: t.actor.userId });
}

/* =============================================================== automation rules */
export const CLIENT_TRIGGERS = ['invoice_overdue', 'quote_expiring', 'departure_upcoming'];

async function matches(t: Tenant, kind: string, days: number): Promise<{ ref_table: string; ref_id: number; client_id: number | null; booking_id?: number; owner?: number | null; label: string; email_ref?: string }[]> {
  const a = t.agencyId;
  if (kind === 'invoice_overdue') return (await t.query(`SELECT id, number, client_id FROM invoices WHERE agency_id = ? AND status IN ('sent','partially_paid','overdue') AND total-amount_credited-amount_paid > 0.005 AND DATEDIFF(CURDATE(), due_date) >= ?`, [a, days]))
    .map((r: any) => ({ ref_table: 'invoices', ref_id: r.id, client_id: r.client_id, label: `Invoice ${r.number} is overdue` }));
  if (kind === 'quote_expiring') return (await t.query(`SELECT id, quote_no, client_id, owner_id FROM quotes WHERE agency_id = ? AND status = 'sent' AND valid_until BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [a, days]))
    .map((r: any) => ({ ref_table: 'quotes', ref_id: r.id, client_id: r.client_id, owner: r.owner_id, label: `Quote ${r.quote_no} expires soon` }));
  if (kind === 'departure_upcoming') return (await t.query(`SELECT id, reference, client_id, agent_id FROM bookings WHERE agency_id = ? AND status IN ('confirmed','ticketed') AND travel_start BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [a, days]))
    .map((r: any) => ({ ref_table: 'bookings', ref_id: r.id, client_id: r.client_id, booking_id: r.id, owner: r.agent_id, label: `Booking ${r.reference} departs soon` }));
  return (await t.query(`SELECT b.id, b.bill_no, s.name FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id AND s.agency_id = b.agency_id WHERE b.agency_id = ? AND b.status IN ('approved','partially_paid') AND b.total-b.amount_paid > 0.005 AND b.due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [a, days]))
    .map((r: any) => ({ ref_table: 'supplier_bills', ref_id: r.id, client_id: null, label: `Bill ${r.bill_no} (${r.name}) is due` }));
}

export function validateRule(r: { trigger_kind: string; action: string }) {
  if (r.action === 'email_client' && !CLIENT_TRIGGERS.includes(r.trigger_kind)) throw new HttpError(400, 'Emailing a client only makes sense for invoice, quote and departure triggers');
}

/**
 * Evaluate every active rule. Each (rule, record) pair is claimed with a unique key before acting, so overlapping
 * runs and re-runs never act twice; failed actions are retried up to 3 times on later runs.
 */
export async function runAutomations(t: Tenant) {
  const rules: any[] = await t.query('SELECT * FROM automation_rules WHERE agency_id = ? AND active = 1 ORDER BY id', [t.agencyId]);
  const summary = { done: 0, failed: 0, skipped: 0 };
  for (const rule of rules) {
    for (const m of await matches(t, rule.trigger_kind, rule.days)) {
      const [ins]: any = await pool.query(`INSERT IGNORE INTO automation_runs (agency_id, rule_id, ref_table, ref_id, status, attempts, detail) VALUES (?,?,?,?, 'skipped', 0, 'claimed')`, [t.agencyId, rule.id, m.ref_table, m.ref_id]);
      if (ins.affectedRows === 0) {   // seen before: only retry failures that still have attempts left, and claim the retry atomically
        const [up]: any = await pool.query(`UPDATE automation_runs SET status = 'skipped', detail = 'retrying' WHERE rule_id = ? AND ref_table = ? AND ref_id = ? AND status = 'failed' AND attempts < 3`, [rule.id, m.ref_table, m.ref_id]);
        if (up.affectedRows === 0) continue;
      }
      let status: 'done' | 'failed' | 'skipped' = 'done', detail = '';
      try {
        if (rule.action === 'create_task') {
          const entity = m.booking_id ? ['booking', m.booking_id] : m.ref_table === 'quotes' ? ['quote', m.ref_id] : m.client_id ? ['client', m.client_id] : [null, null];
          const id = await t.insert('tasks', { title: m.label.slice(0, 200), due_at: today(), priority: rule.task_priority, owner_id: m.owner ?? null, entity_type: entity[0], entity_id: entity[1], notes: (rule.message ?? `Created by rule "${rule.name}"`).slice(0, 500), created_by: null });
          detail = `task #${id}`;
        } else {
          const c = m.client_id ? await t.get('clients', m.client_id) : null;
          if (!c?.email) { status = 'skipped'; detail = 'client has no email'; }
          else {
            const ag = await t.agency(), r = await deliver(t, { kind: 'automation', ref_table: m.ref_table, ref_id: m.ref_id, to: c.email, subject: `${m.label} — ${ag.name}`, html: `<p>Hi ${esc(c.name)},</p><p>${esc(rule.message ?? m.label)}</p><p>— ${esc(ag.name)}</p>` });
            detail = `email ${r}`; if (r === 'failed') status = 'failed';
          }
        }
      } catch (e: any) { status = 'failed'; detail = String(e.message ?? e).slice(0, 290); }
      await pool.query('UPDATE automation_runs SET status = ?, attempts = attempts + 1, detail = ? WHERE rule_id = ? AND ref_table = ? AND ref_id = ?', [status, detail, rule.id, m.ref_table, m.ref_id]);
      summary[status]++;
    }
  }
  return summary;
}

/* =============================================================== scheduled reports */
export function rangeFor(kind: string, on: string): [string, string] {
  const d = new Date(`${on}T00:00:00Z`), y = d.getUTCFullYear(), m = d.getUTCMonth(), iso = (x: Date) => x.toISOString().slice(0, 10);
  if (kind === 'ytd') return [`${y}-01-01`, on];
  if (kind === 'mtd') return [iso(new Date(Date.UTC(y, m, 1))), on];
  if (kind === 'last_month') return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))];
  return [addDays(on, -29), on];
}
export function nextRun(s: { frequency: string; weekday?: number | null; day_of_month?: number | null }, after: string): string {
  if (s.frequency === 'daily') return addDays(after, 1);
  if (s.frequency === 'weekly') { let d = addDays(after, 1); for (let i = 0; i < 7 && new Date(`${d}T00:00:00Z`).getUTCDay() !== (s.weekday ?? 1); i++) d = addDays(d, 1); return d; }
  const [y, m] = after.split('-').map(Number), dom = Math.min(s.day_of_month ?? 1, 28);
  const cand = `${y}-${String(m).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
  return cand > after ? cand : `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
}

export async function reportFile(report: Awaited<ReturnType<typeof buildReport>>, format: string): Promise<{ buf: Buffer; ext: string; mime: string }> {
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(report.title.slice(0, 31)); ws.addRow(report.columns).font = { bold: true };
    report.rows.forEach((r) => ws.addRow(r.map((v) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)))); ws.columns.forEach((c) => (c.width = 20));
    return { buf: Buffer.from(await wb.xlsx.writeBuffer()), ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  if (format === 'pdf') return { buf: await htmlToPdf(tableHtml(report.title, report.columns, report.rows)), ext: 'pdf', mime: 'application/pdf' };
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  return { buf: Buffer.from([report.columns, ...report.rows].map((r) => r.map(cell).join(',')).join('\r\n')), ext: 'csv', mime: 'text/csv' };
}

/** One occurrence of a schedule. The (schedule, run_key) unique row makes it safe to call from several workers or twice. */
export async function executeSchedule(t: Tenant, s: any, runKey: string) {
  const [ins]: any = await pool.query(`INSERT IGNORE INTO report_runs (agency_id, schedule_id, run_key, status) VALUES (?,?,?, 'running')`, [t.agencyId, s.id, runKey]);
  if (ins.affectedRows === 0) return { skipped: true };
  try {
    const [from, to] = rangeFor(s.range_kind, today()), report = await buildReport(t, s.report, from, to), f = await reportFile(report, s.format);
    const key = await putFile(fileKey(t.agencyId, 'scheduled-reports', `${s.report}-${runKey}-${s.id}.${f.ext}`), f.buf, f.mime);
    const bad = report.reconcile?.filter((c) => !c.ok) ?? [];
    const preview = `<table cellpadding="4" style="border-collapse:collapse;font-size:12px"><tr>${report.columns.map((c) => `<th align="left">${esc(c)}</th>`).join('')}</tr>${report.rows.slice(0, 50).map((r) => `<tr>${r.map((v) => `<td>${esc(String(v))}</td>`).join('')}</tr>`).join('')}</table>${report.rows.length > 50 ? `<p>…and ${report.rows.length - 50} more rows (full file under Automation → Schedules).</p>` : ''}`;
    for (const to_ of String(s.recipients).split(',').map((x) => x.trim()).filter(Boolean))
      await deliver(t, { kind: 'scheduled_report', ref_table: 'report_schedules', ref_id: s.id, to: to_, subject: `${s.name}: ${report.title}`,
        html: `<p>${esc(report.title)}</p>${bad.length ? `<p style="color:#b45309"><b>Reconciliation warning:</b> ${bad.map((b) => esc(`${b.label} differs by ${b.difference}`)).join('; ')}</p>` : ''}${preview}` });
    await pool.query(`UPDATE report_runs SET status = 'ok', file_key = ?, row_count = ?, reconciled = ? WHERE schedule_id = ? AND run_key = ?`, [key, report.rows.length, report.reconcile ? (bad.length ? 0 : 1) : null, s.id, runKey]);
    return { ok: true, rows: report.rows.length };
  } catch (e: any) {
    await pool.query(`UPDATE report_runs SET status = 'failed', error = ? WHERE schedule_id = ? AND run_key = ?`, [String(e.message ?? e).slice(0, 290), s.id, runKey]);
    return { ok: false, error: String(e.message ?? e) };
  }
}

export async function runDueSchedules(t: Tenant) {
  const due: any[] = await t.query('SELECT * FROM report_schedules WHERE agency_id = ? AND active = 1 AND next_run_at <= CURDATE()', [t.agencyId]);
  let ran = 0;
  for (const s of due) {
    const runKey = String(s.next_run_at).slice(0, 10);
    const r: any = await executeSchedule(t, s, runKey);
    await pool.query('UPDATE report_schedules SET next_run_at = ?, last_run_at = ?, last_status = ? WHERE id = ? AND agency_id = ?', [nextRun(s, today()), nowSql(), r.skipped ? 'skipped' : r.ok ? 'ok' : 'failed', s.id, t.agencyId]);
    if (!r.skipped) ran++;
  }
  return { ran };
}

/** Everything the daily job does for R6, per agency, each step isolated so one failure cannot block the rest. */
export async function runAgency(agencyId: number) {
  const t = system(agencyId), out: Record<string, unknown> = {};
  const ent = await entitlements(agencyId);
  for (const [k, fn, feat] of [['exceptions', scanExceptions, null], ['automations', runAutomations, 'automation'], ['schedules', runDueSchedules, 'scheduled_reports']] as const)
    try { out[k] = ent.readOnly && feat ? { skipped: 'subscription inactive' } : feat && !ent.features.has(feat) ? { skipped: 'not in plan' } : await fn(t); } catch (e: any) { out[k] = { error: String(e.message ?? e) }; }
  return out;
}
export async function runAll() { const [ags]: any = await pool.query('SELECT id FROM agencies'); for (const a of ags) await runAgency(a.id); }
