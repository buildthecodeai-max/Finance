import type { Request } from 'express';
import { pool, type Tenant } from '../db.js';
import { scope } from '../routes/scope.js';
import { entitlements, usage } from './billing.js';
import { addDays, today } from './money.js';

/**
 * The notification centre. Nothing is stored per event: the list is worked out from the agency's live records each time (what was accepted, paid, is overdue,
 * due today, leaving soon, answered), so it can never fall out of step with the books. Only "I have read this" is stored, per person.
 * A notification's key is stable (what it is about + when it applies), so a read one stays read, and a new development on the same record is new again.
 */
export type Category = 'money' | 'sales' | 'work' | 'trips' | 'account';
export type Severity = 'success' | 'info' | 'warn' | 'danger';
export interface Note { key: string; category: Category; severity: Severity; title: string; body: string; at: string; link: string | null }

const iso = (d: any) => new Date(String(d).length <= 10 ? `${String(d).slice(0, 10)}T00:00:00Z` : String(d).includes('T') ? d : `${String(d).replace(' ', 'T')}Z`).toISOString();
const money = (n: any, c: string) => new Intl.NumberFormat('en', { style: 'currency', currency: c }).format(Number(n));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const MAX_EACH = 25;

export async function derive(req: Request, t: Tenant): Promise<Note[]> {
  const out: Note[] = []; const role = req.ctx!.role, me = req.ctx!.userId, finance = role === 'admin' || role === 'finance_manager', admin = role === 'admin';
  if (role === 'viewer') return out;                                                    // read-only people are not sent things to act on
  const A = t.agencyId, day = today();     // one idea of "today" for every query (the app's own), instead of the database clock

  // Quotes: the client answered
  { const s = scope(req, 'q');
    for (const q of await t.query(`SELECT q.id, q.quote_no, q.title, q.status, COALESCE(q.accepted_at, q.updated_at) at, q.accepted_by_name, c.name client FROM quotes q LEFT JOIN clients c ON c.id = q.client_id AND c.agency_id = q.agency_id
        WHERE q.agency_id = ? AND q.status IN ('accepted','declined','changes_requested') AND q.updated_at > DATE_SUB(NOW(), INTERVAL 14 DAY) ${s.sql} ORDER BY q.updated_at DESC LIMIT ${MAX_EACH}`, [A, ...s.params])) {
      const who = q.accepted_by_name || q.client || 'The client';
      out.push(q.status === 'accepted' ? { key: `quote:${q.id}:accepted`, category: 'sales', severity: 'success', title: `${who} accepted quote ${q.quote_no}`, body: `${q.title}. Turn it into a booking.`, at: iso(q.at), link: `/quotes/${q.id}` }
        : q.status === 'declined' ? { key: `quote:${q.id}:declined`, category: 'sales', severity: 'warn', title: `${who} declined quote ${q.quote_no}`, body: q.title, at: iso(q.at), link: `/quotes/${q.id}` }
        : { key: `quote:${q.id}:changes`, category: 'sales', severity: 'info', title: `${who} asked for changes to ${q.quote_no}`, body: `${q.title}. Revise it and send it again.`, at: iso(q.at), link: `/quotes/${q.id}` }); } }

  // Money in, and invoices that need chasing
  if (finance) {
    for (const p of await t.query(`SELECT p.id, p.amount, p.currency, p.paid_at, c.name client FROM payments p LEFT JOIN clients c ON c.id = p.client_id AND c.agency_id = p.agency_id WHERE p.agency_id = ? AND p.direction = 'inbound' AND p.voided = 0 AND p.paid_at >= DATE_SUB('${day}', INTERVAL 7 DAY) ORDER BY p.paid_at DESC, p.id DESC LIMIT ${MAX_EACH}`, [A]))
      out.push({ key: `payment:${p.id}`, category: 'money', severity: 'success', title: `Payment received: ${money(p.amount, p.currency)}`, body: p.client ? `From ${p.client}.` : 'A client payment was recorded.', at: iso(p.paid_at), link: '/payments' });
    for (const i of await t.query(`SELECT i.id, i.number, i.due_date, ROUND(i.total - i.amount_credited - i.amount_paid, 2) owing, i.currency, DATEDIFF('${day}', i.due_date) late, c.name client FROM invoices i LEFT JOIN clients c ON c.id = i.client_id AND c.agency_id = i.agency_id
        WHERE i.agency_id = ? AND i.status IN ('sent','partially_paid','overdue') AND i.total - i.amount_credited - i.amount_paid > 0.005 AND i.due_date < '${day}' AND i.due_date >= DATE_SUB('${day}', INTERVAL 30 DAY) ORDER BY i.due_date DESC LIMIT ${MAX_EACH}`, [A]))
      out.push({ key: `inv-overdue:${i.id}`, category: 'money', severity: i.late > 14 ? 'danger' : 'warn', title: `Invoice ${i.number} is ${plural(i.late, 'day')} overdue`, body: `${i.client ?? 'The client'} owes ${money(i.owing, i.currency)}.`, at: iso(addDays(i.due_date, 1)), link: `/invoices?open=${i.id}` });
    for (const i of await t.query(`SELECT i.id, i.number, i.due_date, ROUND(i.total - i.amount_credited - i.amount_paid, 2) owing, i.currency, DATEDIFF(i.due_date, '${day}') days, c.name client FROM invoices i LEFT JOIN clients c ON c.id = i.client_id AND c.agency_id = i.agency_id
        WHERE i.agency_id = ? AND i.status IN ('sent','partially_paid') AND i.total - i.amount_credited - i.amount_paid > 0.005 AND i.due_date BETWEEN '${day}' AND DATE_ADD('${day}', INTERVAL 3 DAY) ORDER BY i.due_date LIMIT ${MAX_EACH}`, [A]))
      out.push({ key: `inv-due:${i.id}`, category: 'money', severity: 'info', title: `Invoice ${i.number} is due ${i.days === 0 ? 'today' : i.days === 1 ? 'tomorrow' : `in ${i.days} days`}`, body: `${i.client ?? 'The client'} owes ${money(i.owing, i.currency)}.`, at: iso(day), link: `/invoices?open=${i.id}` });
    for (const e of await t.query(`SELECT id, severity, title, detail, last_seen FROM exceptions WHERE agency_id = ? AND status = 'open' AND severity IN ('critical','warn') AND (snoozed_until IS NULL OR snoozed_until <= '${day}') ORDER BY FIELD(severity,'critical','warn'), last_seen DESC LIMIT 10`, [A]))
      out.push({ key: `exception:${e.id}`, category: 'money', severity: e.severity === 'critical' ? 'danger' : 'warn', title: e.title, body: e.detail ?? 'Found by the automatic checks.', at: iso(e.last_seen), link: '/automation' }); }

  // Your own work: tasks and lead follow-ups that are due
  for (const k of await t.query(`SELECT id, title, due_at FROM tasks WHERE agency_id = ? AND owner_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at <= '${day}' ORDER BY due_at DESC LIMIT ${MAX_EACH}`, [A, me])) {
    const late = Math.round((Date.parse(day) - Date.parse(String(k.due_at).slice(0, 10))) / 864e5);
    out.push({ key: `task:${k.id}:${String(k.due_at).slice(0, 10)}`, category: 'work', severity: late > 0 ? 'warn' : 'info', title: late > 0 ? `Task overdue: ${k.title}` : `Task due today: ${k.title}`, body: late > 0 ? `It was due ${plural(late, 'day')} ago.` : 'Due today.', at: iso(k.due_at), link: '/operations' }); }
  for (const l of await t.query(`SELECT id, name, next_action, next_action_at FROM leads WHERE agency_id = ? AND owner_id = ? AND stage IN ('new','contacted','quoted','negotiating') AND next_action_at IS NOT NULL AND next_action_at <= '${day}' ORDER BY next_action_at DESC LIMIT ${MAX_EACH}`, [A, me]))
    out.push({ key: `lead:${l.id}:${String(l.next_action_at).slice(0, 10)}`, category: 'work', severity: String(l.next_action_at).slice(0, 10) < day ? 'warn' : 'info', title: `Follow up with ${l.name}`, body: l.next_action || 'A follow-up is due.', at: iso(l.next_action_at), link: `/leads?open=${l.id}` });

  // Trips leaving soon
  { const s = scope(req, 'b', { owner: 'agent_id' });
    for (const b of await t.query(`SELECT b.id, b.reference, b.destination, b.travel_start, DATEDIFF(b.travel_start, '${day}') days, c.name client FROM bookings b LEFT JOIN clients c ON c.id = b.client_id AND c.agency_id = b.agency_id
        WHERE b.agency_id = ? AND b.archived_at IS NULL AND b.status IN ('confirmed','in_service','awaiting_client') AND b.travel_start BETWEEN '${day}' AND DATE_ADD('${day}', INTERVAL 7 DAY) ${s.sql} ORDER BY b.travel_start LIMIT ${MAX_EACH}`, [A, ...s.params]))
      out.push({ key: `trip:${b.id}`, category: 'trips', severity: b.days <= 2 ? 'warn' : 'info', title: `${b.client ?? b.reference} leaves ${b.days === 0 ? 'today' : b.days === 1 ? 'tomorrow' : `in ${b.days} days`}`, body: `${b.reference}${b.destination ? ` to ${b.destination}` : ''}. Check documents and vouchers.`, at: iso(day), link: `/bookings/${b.id}` }); }

  // Replies from support
  for (const h of await t.query(`SELECT id, subject, status, replied_at FROM help_requests WHERE agency_id = ? AND replied_at IS NOT NULL AND replied_at > DATE_SUB(NOW(), INTERVAL 14 DAY) ${finance ? '' : 'AND user_id = ?'} ORDER BY replied_at DESC LIMIT 10`, finance ? [A] : [A, me]))
    out.push({ key: `help:${h.id}:${iso(h.replied_at)}`, category: 'account', severity: 'info', title: 'Support replied to your request', body: h.subject, at: iso(h.replied_at), link: '/support-center' });

  // The plan: only the owner is told
  if (admin) {
    const e = await entitlements(A); const sub = e.sub;
    if (sub?.status === 'trialing' && sub.trial_ends_at) { const days = Math.ceil((Date.parse(String(sub.trial_ends_at).replace(' ', 'T') + 'Z') - Date.now()) / 864e5); if (days <= 3 && days >= 0) out.push({ key: `plan:trial:${String(sub.trial_ends_at).slice(0, 10)}`, category: 'account', severity: days <= 1 ? 'danger' : 'warn', title: days === 0 ? 'Your free trial ends today' : `Your free trial ends in ${plural(days, 'day')}`, body: 'Choose a plan to keep your workspace running without interruption.', at: iso(day), link: '/billing' }); }
    if (['past_due', 'grace'].includes(e.status)) out.push({ key: `plan:pastdue:${day.slice(0, 7)}`, category: 'account', severity: 'danger', title: 'Your last subscription payment did not go through', body: 'Update your payment method so nothing is interrupted.', at: iso(day), link: '/billing' });
    const u = await usage(A);
    for (const [k, label] of [['seats', 'team members'], ['branches', 'branches'], ['bookings', 'bookings this month']] as const) { const lim = e.limits[k]; if (lim && u[k] / lim >= 0.9) out.push({ key: `plan:limit:${k}:${lim}:${k === 'bookings' ? day.slice(0, 7) : ''}`, category: 'account', severity: u[k] >= lim ? 'danger' : 'warn', title: u[k] >= lim ? `You have reached your limit of ${label}` : `You are close to your limit of ${label}`, body: `${u[k]} of ${lim} used. Upgrade to add more.`, at: iso(day), link: '/billing' }); }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

const cache = new Map<string, { at: number; notes: Note[] }>();
export async function feed(req: Request, t: Tenant) {
  const ck = `${t.agencyId}:${req.ctx!.userId}`; let c = cache.get(ck);
  if (!c || Date.now() - c.at > 15_000) { c = { at: Date.now(), notes: await derive(req, t) }; cache.set(ck, c); if (cache.size > 500) cache.clear(); }
  const [rows]: any = await pool.query('SELECT nkey FROM notification_state WHERE agency_id = ? AND user_id = ?', [t.agencyId, req.ctx!.userId]); const read = new Set(rows.map((r: any) => r.nkey));
  const items = c.notes.map((n) => ({ ...n, read: read.has(n.key) })); const unread = items.filter((n) => !n.read);
  const counts: Record<string, number> = { all: unread.length, money: 0, sales: 0, work: 0, trips: 0, account: 0 }; for (const n of unread) counts[n.category]++;
  return { items: items.slice(0, 150), unread: unread.length, counts };
}
export const dropFeedCache = (agencyId: number, userId: number) => cache.delete(`${agencyId}:${userId}`);

export async function mark(req: Request, t: Tenant, b: { keys?: string[]; all?: boolean }, read: boolean) {
  const A = t.agencyId, me = req.ctx!.userId;
  const keys = b.all ? (await derive(req, t)).map((n) => n.key) : (b.keys ?? []);
  if (read) for (const k of keys) await pool.query('INSERT IGNORE INTO notification_state (agency_id, user_id, nkey) VALUES (?,?,?)', [A, me, k.slice(0, 120)]);
  else if (keys.length) await pool.query(`DELETE FROM notification_state WHERE agency_id = ? AND user_id = ? AND nkey IN (${keys.map(() => '?').join(',')})`, [A, me, ...keys.map((k) => k.slice(0, 120))]);
  await pool.query('DELETE FROM notification_state WHERE read_at < DATE_SUB(NOW(), INTERVAL 90 DAY)');         // old marks refer to things that have long since left the list
  dropFeedCache(A, me); return { ok: true, marked: keys.length };
}
