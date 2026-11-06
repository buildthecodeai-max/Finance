import { emit } from '../services/webhooks.js';
import { Router } from 'express';
import { z } from 'zod';
import { ALL_EDITORS, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { Tenant } from '../db.js';
import { addDays, today } from '../services/money.js';
import { assertCanEdit, findScoped, scope } from './scope.js';
import { idParam, parse, T } from './util.js';

export const leadsRouter = Router();
export const crmRouter = Router();
export const opsRouter = Router();

const STAGES = ['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost'] as const;
const opt = <S extends z.ZodTypeAny>(s: S) => s.nullish();
const Lead = z.object({
  name: z.string().min(1), email: opt(z.string().email()), phone: opt(z.string()), source: opt(z.string()), enquiry_type: opt(z.string()), destination: opt(z.string()),
  budget_min: opt(z.number().min(0)), budget_max: opt(z.number().min(0)), currency: opt(z.string().length(3)), travel_start: opt(z.string()), travel_end: opt(z.string()),
  party_size: opt(z.number().int().min(1)), owner_id: opt(z.number().int()), branch_id: opt(z.number().int()), stage: z.enum(STAGES).default('new'),
  next_action: opt(z.string()), next_action_at: opt(z.string()), lost_reason: opt(z.string()), client_id: opt(z.number().int()),
});

async function log(t: Tenant, type: string, id: number, body: string, kind = 'system') {
  await t.insert('activities', { entity_type: type, entity_id: id, kind, body, created_by: t.actor.userId });
}

async function duplicates(t: Tenant, email?: string | null, phone?: string | null, exceptLead?: number) {
  if (!email && !phone) return [];
  const conds: string[] = [], p: any[] = [];
  if (email) { conds.push('email = ?'); p.push(email); } if (phone) { conds.push('phone = ?'); p.push(phone); }
  const leads = await t.query(`SELECT id, name, 'lead' type FROM leads WHERE agency_id = ? AND (${conds.join(' OR ')}) ${exceptLead ? 'AND id <> ?' : ''} LIMIT 5`, [t.agencyId, ...p, ...(exceptLead ? [exceptLead] : [])]);
  const clients = await t.query(`SELECT id, name, 'client' type FROM clients WHERE agency_id = ? AND (${conds.join(' OR ')}) LIMIT 5`, [t.agencyId, ...p]);
  return [...leads, ...clients];
}

async function leadRefs(t: Tenant, b: Record<string, any>) {
  await t.memberRef(b.owner_id, 'owner'); await t.ref('branches', b.branch_id, 'branch'); await t.ref('clients', b.client_id, 'client');
}

// ---------- Leads ----------
leadsRouter.get('/', async (req, res) => {
  const t = T(req), { stage, q } = req.query as Record<string, string>, s = scope(req, 'l');
  res.json(await t.query(
    `SELECT l.*, u.name owner_name,
       (SELECT MAX(a.created_at) FROM activities a WHERE a.agency_id = l.agency_id AND a.entity_type = 'lead' AND a.entity_id = l.id AND a.kind <> 'system') last_contact_at,
       (SELECT COUNT(*) FROM quotes q WHERE q.agency_id = l.agency_id AND q.lead_id = l.id) quote_count
     FROM leads l LEFT JOIN users u ON u.id = l.owner_id WHERE l.agency_id = ?${s.sql}
     ${stage ? 'AND l.stage = ?' : ''} ${q ? 'AND (l.name LIKE ? OR l.email LIKE ? OR l.destination LIKE ?)' : ''} ORDER BY l.updated_at DESC LIMIT 500`,
    [t.agencyId, ...s.params, ...(stage ? [stage] : []), ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])]));
});

/** Live "is this person already here?" check for the new-lead form: matches on email or phone, across leads and clients. */
leadsRouter.get('/duplicates', async (req, res) => {
  const { email, phone } = req.query as Record<string, string>;
  res.json(await duplicates(T(req), email?.trim() || null, phone?.trim() || null));
});

leadsRouter.get('/:id', async (req, res) => {
  const t = T(req), id = idParam(req), lead = await findScoped(t, req, 'leads', id), qs = scope(req, 'q');
  res.json({
    ...lead, owner_name: lead.owner_id ? (await t.one('SELECT u.name FROM users u JOIN memberships m ON m.user_id = u.id AND m.agency_id = ? WHERE u.id = ?', [t.agencyId, lead.owner_id]))?.name ?? null : null,
    quotes: await t.query(`SELECT q.id, q.quote_no, q.title, q.status FROM quotes q WHERE q.agency_id = ? AND q.lead_id = ?${qs.sql} ORDER BY q.id DESC`, [t.agencyId, id, ...qs.params]),
    activities: await t.query(`SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id = a.created_by WHERE a.agency_id = ? AND a.entity_type = 'lead' AND a.entity_id = ? ORDER BY a.id DESC`, [t.agencyId, id]),
    tasks: await t.query(`SELECT * FROM tasks WHERE agency_id = ? AND entity_type = 'lead' AND entity_id = ? ORDER BY status, due_at`, [t.agencyId, id]),
    duplicates: await duplicates(t, lead.email, lead.phone, id),
  });
});

/** A trip cannot end before it starts, and a budget range must run low to high. */
function checkRanges(start: unknown, end: unknown, min: unknown, max: unknown) {
  const d = (v: unknown) => (v ? String(v).slice(0, 10) : '');
  if (d(start) && d(end) && d(end) < d(start)) throw new HttpError(400, 'The travel end date is before the start date');
  if (min != null && max != null && Number(max) < Number(min)) throw new HttpError(400, 'The maximum budget is below the minimum');
}

leadsRouter.post('/', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(Lead, req.body), t = T(req); checkRanges(b.travel_start, b.travel_end, b.budget_min, b.budget_max);
  if (req.ctx!.role === 'agent') b.owner_id = req.ctx!.userId; else b.owner_id ??= req.ctx!.userId;
  if (req.ctx!.branchId) b.branch_id = req.ctx!.branchId;
  await leadRefs(t, b);
  const id = await t.insert('leads', { ...b, created_by: req.ctx!.userId });
  await emit(t, 'lead.created', { lead_id: id, source: b.source ?? null, stage: 'new' });
  res.status(201).json({ id, duplicates: await duplicates(t, b.email, b.phone, id) }); // warn, never block
});

leadsRouter.put('/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), cur = await findScoped(t, req, 'leads', id);
  assertCanEdit(req, cur);
  const b = parse(Lead.partial(), req.body);
  if (req.ctx!.role === 'agent') delete b.owner_id; // agents can't reassign
  checkRanges(b.travel_start ?? cur.travel_start, b.travel_end ?? cur.travel_end, b.budget_min ?? cur.budget_min, b.budget_max ?? cur.budget_max);
  if (b.stage && b.stage !== 'lost' && cur.stage === 'lost') b.lost_reason = null;   // reopening a lead forgets why it was lost
  await leadRefs(t, b);
  await t.tx(async (tx) => {
    await tx.update('leads', id, b);
    if (b.stage && b.stage !== cur.stage) await log(tx, 'lead', id, `Stage changed: ${cur.stage} → ${b.stage}${b.lost_reason ? ` (${b.lost_reason})` : ''}`);
  });
  res.json({ ok: true });
});

// Lead → client (idempotent: a second call returns the existing client)
leadsRouter.post('/:id/convert-client', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), lead = await findScoped(t, req, 'leads', id);
  assertCanEdit(req, lead);
  if (lead.client_id) return void res.json({ client_id: lead.client_id, existing: true });
  const clientId = await t.tx(async (tx) => {
    const cid = await tx.insert('clients', { name: lead.name, email: lead.email, phone: lead.phone, currency: lead.currency ?? 'USD' });
    await tx.update('leads', id, { client_id: cid });
    await log(tx, 'lead', id, `Converted to client #${cid}`); await log(tx, 'client', cid, `Created from lead #${id}`);
    return cid;
  });
  res.status(201).json({ client_id: clientId, existing: false });
});

// ---------- Activities ----------
const ENTITY_TABLE: Record<string, string> = { lead: 'leads', client: 'clients', quote: 'quotes', booking: 'bookings' };
const OWNER_COL: Record<string, string> = { lead: 'owner_id', quote: 'owner_id', booking: 'agent_id' };

/** The caller must be allowed to see the entity an activity/task hangs off. */
async function assertEntity(t: Tenant, req: any, type: string, id: number) {
  const table = ENTITY_TABLE[type]; if (!table) throw new HttpError(400, 'Unknown entity type');
  if (type === 'client') { await t.ref('clients', id, 'client'); return; }
  await findScoped(t, req, table, id, { owner: OWNER_COL[type] });
}

crmRouter.get('/activities', async (req, res) => {
  const t = T(req), { entity_type, entity_id } = req.query as Record<string, string>;
  await assertEntity(t, req, entity_type, Number(entity_id));
  res.json(await t.query(`SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id = a.created_by WHERE a.agency_id = ? AND a.entity_type = ? AND a.entity_id = ? ORDER BY a.id DESC LIMIT 200`, [t.agencyId, entity_type, Number(entity_id)]));
});

crmRouter.post('/activities', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(z.object({ entity_type: z.enum(['lead', 'client', 'quote', 'booking']), entity_id: z.number().int(), kind: z.enum(['note', 'call', 'email', 'meeting']).default('note'), body: z.string().min(1).max(5000) }), req.body);
  const t = T(req); await assertEntity(t, req, b.entity_type, b.entity_id);
  res.status(201).json({ id: await t.insert('activities', { ...b, created_by: req.ctx!.userId }) });
});

// Unified client timeline: notes + leads + quotes + bookings + invoices + payments
crmRouter.get('/timeline/client/:id', async (req, res) => {
  const t = T(req), id = idParam(req); await t.ref('clients', id, 'client');
  const a = t.agencyId;
  const [acts, leads, quotes, bookings, invoices, payments] = await Promise.all([
    t.query(`SELECT a.created_at at, CONCAT(UPPER(LEFT(a.kind,1)), SUBSTRING(a.kind,2)) label, a.body detail, u.name who, 'activity' type FROM activities a LEFT JOIN users u ON u.id = a.created_by WHERE a.agency_id = ? AND a.entity_type = 'client' AND a.entity_id = ?`, [a, id]),
    t.query(`SELECT created_at at, CONCAT('Lead: ', COALESCE(destination, name)) label, stage detail, NULL who, 'lead' type FROM leads WHERE agency_id = ? AND client_id = ?`, [a, id]),
    t.query(`SELECT created_at at, CONCAT('Quote ', quote_no) label, status detail, NULL who, 'quote' type FROM quotes WHERE agency_id = ? AND client_id = ?`, [a, id]),
    t.query(`SELECT created_at at, CONCAT('Booking ', reference) label, CONCAT(status, COALESCE(CONCAT(' · ', destination), '')) detail, NULL who, 'booking' type FROM bookings WHERE agency_id = ? AND client_id = ?`, [a, id]),
    t.query(`SELECT created_at at, CONCAT('Invoice ', number) label, CONCAT(status, ' · ', total, ' ', currency) detail, NULL who, 'invoice' type FROM invoices WHERE agency_id = ? AND client_id = ?`, [a, id]),
    t.query(`SELECT created_at at, CONCAT('Payment ', amount, ' ', currency) label, method detail, NULL who, 'payment' type FROM payments WHERE agency_id = ? AND client_id = ? AND direction = 'inbound'`, [a, id]),
  ]);
  res.json([...acts, ...leads, ...quotes, ...bookings, ...invoices, ...payments].sort((x: any, y: any) => String(y.at).localeCompare(String(x.at))).slice(0, 300));
});

// ---------- Tasks ----------
const Task = z.object({
  title: z.string().min(1).max(200), due_at: opt(z.string()), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  owner_id: opt(z.number().int()), entity_type: opt(z.enum(['lead', 'client', 'quote', 'booking'])), entity_id: opt(z.number().int()), notes: opt(z.string().max(500)),
});

// What a task hangs off, in words (lead/client name, quote number, booking reference + client), and a phone/email to reach them where the record has one.
const ABOUT_ONE = (sel: string, from: string) => `(SELECT ${sel} FROM ${from} WHERE x.agency_id = k.agency_id AND x.id = k.entity_id)`;
const TASK_ABOUT = `CASE k.entity_type
    WHEN 'lead' THEN ${ABOUT_ONE('x.name', 'leads x')} WHEN 'client' THEN ${ABOUT_ONE('x.name', 'clients x')} WHEN 'quote' THEN ${ABOUT_ONE('x.quote_no', 'quotes x')}
    WHEN 'booking' THEN ${ABOUT_ONE(`CONCAT(x.reference, COALESCE(CONCAT(' · ', c.name), ''))`, 'bookings x LEFT JOIN clients c ON c.id = x.client_id AND c.agency_id = x.agency_id')} END entity_label,
  CASE k.entity_type
    WHEN 'lead' THEN ${ABOUT_ONE('x.phone', 'leads x')} WHEN 'client' THEN ${ABOUT_ONE('x.phone', 'clients x')}
    WHEN 'booking' THEN ${ABOUT_ONE('c.phone', 'bookings x LEFT JOIN clients c ON c.id = x.client_id AND c.agency_id = x.agency_id')} END entity_phone,
  CASE k.entity_type
    WHEN 'lead' THEN ${ABOUT_ONE('x.email', 'leads x')} WHEN 'client' THEN ${ABOUT_ONE('x.email', 'clients x')}
    WHEN 'booking' THEN ${ABOUT_ONE('c.email', 'bookings x LEFT JOIN clients c ON c.id = x.client_id AND c.agency_id = x.agency_id')} END entity_email`;

crmRouter.get('/tasks', async (req, res) => {
  const t = T(req), { mine, status, entity_type, entity_id } = req.query as Record<string, string>;
  const agent = req.ctx!.role === 'agent';
  res.json(await t.query(
    `SELECT k.*, u.name owner_name, ${TASK_ABOUT} FROM tasks k LEFT JOIN users u ON u.id = k.owner_id WHERE k.agency_id = ?
     ${mine || agent ? 'AND k.owner_id = ?' : ''} ${status ? 'AND k.status = ?' : ''} ${entity_type ? 'AND k.entity_type = ? AND k.entity_id = ?' : ''}
     ORDER BY k.status = 'open' DESC, k.due_at IS NULL, k.due_at, FIELD(k.priority,'urgent','high','normal','low') LIMIT 500`,
    [t.agencyId, ...(mine || agent ? [req.ctx!.userId] : []), ...(status ? [status] : []), ...(entity_type ? [entity_type, Number(entity_id)] : [])]));
});

crmRouter.post('/tasks', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(Task, req.body), t = T(req);
  if (req.ctx!.role === 'agent') b.owner_id = req.ctx!.userId; else b.owner_id ??= req.ctx!.userId;
  await t.memberRef(b.owner_id, 'owner');
  if (b.entity_type && b.entity_id) await assertEntity(t, req, b.entity_type, b.entity_id);
  res.status(201).json({ id: await t.insert('tasks', { ...b, created_by: req.ctx!.userId }) });
});

async function myTask(req: any, id: number) {
  const t = T(req), k = await t.get('tasks', id);
  if (!k || (req.ctx.role === 'agent' && k.owner_id !== req.ctx.userId)) throw new HttpError(404, 'Not found');
  return k;
}
crmRouter.put('/tasks/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const id = idParam(req); await myTask(req, id);
  const b = parse(Task.partial(), req.body); if (req.ctx!.role === 'agent') delete b.owner_id;
  await T(req).memberRef(b.owner_id, 'owner'); await T(req).update('tasks', id, b); res.json({ ok: true });
});
crmRouter.post('/tasks/:id/complete', requireRole(...ALL_EDITORS), async (req, res) => {
  const id = idParam(req), k = await myTask(req, id), t = T(req);
  if (k.status !== 'open') throw new HttpError(409, 'Task is not open');
  const { notes } = parse(z.object({ notes: z.string().max(500).optional() }), req.body);
  await t.update('tasks', id, { status: 'done', completed_at: new Date().toISOString().slice(0, 19).replace('T', ' '), completed_by: req.ctx!.userId, ...(notes ? { notes } : {}) });
  res.json({ ok: true });
});
crmRouter.post('/tasks/:id/reopen', requireRole(...ALL_EDITORS), async (req, res) => {   // the undo for "done"
  const id = idParam(req), k = await myTask(req, id);
  if (k.status !== 'done') throw new HttpError(409, 'Task is not done');
  await T(req).update('tasks', id, { status: 'open', completed_at: null, completed_by: null });
  res.json({ ok: true });
});

// ---------- Operations: upcoming deadlines across the agency ----------
opsRouter.get('/deadlines', requireRole('admin', 'finance_manager', 'agent', 'viewer'), async (req, res) => {
  const t = T(req), days = Math.min(Number(req.query.days) || 30, 180), from = today(), to = addDays(from, days);
  const bs = scope(req, 'b', { owner: 'agent_id' }), qs = scope(req, 'q'), ls = scope(req, 'l');
  const mine = req.ctx!.role === 'agent';
  const rows = await Promise.all([
    t.query(`SELECT 'departure' kind, b.travel_start date, CONCAT(b.reference, ' departs', COALESCE(CONCAT(' — ', b.destination), '')) title, 'booking' ref_type, b.id ref_id, 'info' severity,
               cl.name who, cl.phone, cl.email, b.agent_id owner_id, u.name owner_name
             FROM bookings b LEFT JOIN clients cl ON cl.id = b.client_id AND cl.agency_id = b.agency_id LEFT JOIN users u ON u.id = b.agent_id
             WHERE b.agency_id = ?${bs.sql} AND b.travel_start BETWEEN ? AND ? AND b.status IN ('confirmed','in_service')`, [t.agencyId, ...bs.params, from, to]),
    t.query(`SELECT 'unconfirmed_supplier' kind, c.service_start date, CONCAT(b.reference, ': ', c.description, ' not confirmed') title, 'booking' ref_type, b.id ref_id,
               IF(c.service_start <= DATE_ADD(CURDATE(), INTERVAL 7 DAY), 'high', 'medium') severity, s.name who, NULL phone, s.email, b.agent_id owner_id, u.name owner_name
             FROM booking_components c JOIN bookings b ON b.id = c.booking_id AND b.agency_id = c.agency_id
             LEFT JOIN suppliers s ON s.id = c.supplier_id AND s.agency_id = c.agency_id LEFT JOIN users u ON u.id = b.agent_id
             WHERE c.agency_id = ?${bs.sql} AND c.confirmation_status IN ('pending','requested','waitlisted') AND c.service_start BETWEEN ? AND ? AND b.status IN ('confirmed','in_service')`, [t.agencyId, ...bs.params, from, to]),
    t.query(`SELECT 'quote_expiry' kind, q.valid_until date, CONCAT('Quote ', q.quote_no, ' expires') title, 'quote' ref_type, q.id ref_id, 'medium' severity,
               COALESCE(cl.name, ld.name) who, COALESCE(cl.phone, ld.phone) phone, COALESCE(cl.email, ld.email) email, q.title detail, q.owner_id, u.name owner_name
             FROM quotes q LEFT JOIN clients cl ON cl.id = q.client_id AND cl.agency_id = q.agency_id LEFT JOIN leads ld ON ld.id = q.lead_id AND ld.agency_id = q.agency_id LEFT JOIN users u ON u.id = q.owner_id
             WHERE q.agency_id = ?${qs.sql} AND q.status = 'sent' AND q.valid_until BETWEEN ? AND ?`, [t.agencyId, ...qs.params, from, to]),
    // Dated by the departure — the day it can no longer be fixed — not by the day the passport lapses (which may be months away, or already past).
    t.query(`SELECT 'passport_expiry' kind, b.travel_start date, CONCAT(tr.first_name, ' ', tr.last_name, ': passport expires within 6 months of travel (', b.reference, ')') title, 'booking' ref_type, b.id ref_id, 'high' severity,
               CONCAT(tr.first_name, ' ', tr.last_name) who, COALESCE(tr.phone, cl.phone) phone, COALESCE(tr.email, cl.email) email, CONCAT('Passport expires ', DATE_FORMAT(tr.passport_expiry, '%e %b %Y')) detail, b.agent_id owner_id, u.name owner_name
             FROM travellers tr JOIN booking_travellers bt ON bt.traveller_id = tr.id AND bt.agency_id = tr.agency_id JOIN bookings b ON b.id = bt.booking_id AND b.agency_id = bt.agency_id
             LEFT JOIN clients cl ON cl.id = b.client_id AND cl.agency_id = b.agency_id LEFT JOIN users u ON u.id = b.agent_id
             WHERE tr.agency_id = ?${bs.sql} AND tr.passport_expiry IS NOT NULL AND b.travel_start BETWEEN ? AND ? AND tr.passport_expiry < DATE_ADD(COALESCE(b.travel_end, b.travel_start), INTERVAL 6 MONTH)
               AND b.status IN ('confirmed','in_service')`, [t.agencyId, ...bs.params, from, to]),
    // Birthdays of travellers on live bookings (the people you may want to greet or upsell to).
    t.query(`SELECT 'birthday' kind, x.next_bday date, CONCAT(x.name, ' turns ', YEAR(x.next_bday) - YEAR(x.dob), ' on this date (', x.ref, ')') title, 'booking' ref_type, x.booking_id ref_id, 'info' severity,
               x.name who, x.phone, x.email, x.agent_id owner_id, u.name owner_name FROM (
               SELECT CONCAT(tr.first_name, ' ', tr.last_name) name, tr.dob, tr.phone, tr.email, MIN(b.id) booking_id, MIN(b.reference) ref, MIN(b.agent_id) agent_id,
                      DATE_ADD(tr.dob, INTERVAL YEAR(CURDATE()) - YEAR(tr.dob) + (DATE_FORMAT(CURDATE(), '%m%d') > DATE_FORMAT(tr.dob, '%m%d')) YEAR) next_bday
               FROM travellers tr JOIN booking_travellers bt ON bt.traveller_id = tr.id AND bt.agency_id = tr.agency_id JOIN bookings b ON b.id = bt.booking_id AND b.agency_id = bt.agency_id
               WHERE tr.agency_id = ?${bs.sql} AND tr.dob IS NOT NULL AND b.archived_at IS NULL AND b.status IN ('enquiry','quoted','awaiting_client','confirmed','in_service') GROUP BY tr.id) x
             LEFT JOIN users u ON u.id = x.agent_id
             WHERE x.next_bday BETWEEN ? AND ?`, [t.agencyId, ...bs.params, from, to]),
    // Lead follow-ups: due in the window, or already overdue (they stay on the list until someone acts).
    t.query(`SELECT 'lead_followup' kind, l.next_action_at date, CONCAT('Follow up with ', l.name, COALESCE(CONCAT(' — ', l.next_action), '')) title, 'lead' ref_type, l.id ref_id, IF(l.next_action_at < ?, 'high', 'medium') severity,
               l.name who, l.phone, l.email, l.next_action action, l.stage, l.destination detail, l.owner_id, u.name owner_name
             FROM leads l LEFT JOIN users u ON u.id = l.owner_id WHERE l.agency_id = ?${ls.sql} AND l.stage NOT IN ('won','lost') AND l.next_action_at IS NOT NULL AND l.next_action_at <= ?`, [from, t.agencyId, ...ls.params, to]),
    t.query(`SELECT 'task' kind, k.due_at date, k.title, k.entity_type ref_type, k.entity_id ref_id, IF(k.priority IN ('urgent','high'),'high','medium') severity
             FROM tasks k WHERE k.agency_id = ? AND k.status = 'open' AND k.due_at BETWEEN ? AND ? ${mine ? 'AND k.owner_id = ?' : ''}`, [t.agencyId, from, to, ...(mine ? [req.ctx!.userId] : [])]),
    t.query(`SELECT 'overdue_task' kind, k.due_at date, k.title, k.entity_type ref_type, k.entity_id ref_id, 'high' severity
             FROM tasks k WHERE k.agency_id = ? AND k.status = 'open' AND k.due_at < ? ${mine ? 'AND k.owner_id = ?' : ''}`, [t.agencyId, from, ...(mine ? [req.ctx!.userId] : [])]),
  ]);
  res.json(rows.flat().sort((x: any, y: any) => String(x.date).localeCompare(String(y.date))));
});

