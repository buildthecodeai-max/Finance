import { archiveBooking, dependents, restoreBooking } from '../services/records.js';
import { assertWithinLimit } from '../services/billing.js';
import { Router } from 'express';
import { z } from 'zod';
import { ALL_EDITORS, WRITERS, requireRole } from '../auth.js';
import { decrypt, encrypt } from '../crypto.js';
import { HttpError } from '../errors.js';
import { pool, Tenant } from '../db.js';
import { nextDocNo } from '../services/accounting.js';
import { r2 } from '../services/money.js';
import { marginPct, priceComponent } from '../services/pricing.js';
import { safeRecalc } from '../services/commissions.js';
import { assertCanEdit, findScoped, scope } from './scope.js';
import { idParam, parse, T } from './util.js';

export const bookingsRouter = Router();
export const travellersRouter = Router();

const STATUSES = ['enquiry', 'quoted', 'awaiting_client', 'confirmed', 'in_service', 'travel_completed', 'closed', 'on_hold', 'cancelled', 'refunded', 'lost'] as const;
const TERMINAL = ['closed', 'cancelled', 'refunded', 'lost'];
const NEEDS_REASON = ['cancelled', 'lost', 'on_hold', 'refunded'];
const TYPES = ['flight', 'hotel', 'package', 'cruise', 'transfer', 'tour', 'rail', 'car', 'insurance', 'visa', 'fee', 'other'] as const;
const nul = <S extends z.ZodTypeAny>(s: S) => s.nullish();
const OWN = { owner: 'agent_id' };

const Booking = z.object({
  client_id: z.number().int(), agent_id: nul(z.number().int()), branch_id: nul(z.number().int()), reference: z.string().min(1).max(50).optional(),
  destination: nul(z.string().max(150)), travel_start: nul(z.string()), travel_end: nul(z.string()), overhead: z.number().min(0).default(0),
  status: z.enum(STATUSES).default('enquiry'), channel: nul(z.string().max(40)), trip_purpose: nul(z.string().max(60)), notes: nul(z.string()), currency: z.string().length(3).optional(),
  reason: z.string().max(300).optional(),
});
const TRACKED = ['status', 'client_id', 'agent_id', 'branch_id', 'destination', 'travel_start', 'travel_end', 'currency', 'overhead', 'channel', 'trip_purpose'];

/** Append who/what/why to the booking change log. */
async function logChange(t: Tenant, bookingId: number, field: string, oldV: unknown, newV: unknown, reason?: string) {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 500));
  if (s(oldV) === s(newV)) return;
  await t.query('INSERT INTO booking_changes (agency_id, booking_id, field, old_value, new_value, reason, user_id) VALUES (?,?,?,?,?,?,?)',
    [t.agencyId, bookingId, field, s(oldV), s(newV), reason ?? null, t.actor.userId]);
}
const diff = async (t: Tenant, id: number, before: any, after: Record<string, any>, reason?: string, prefix = '') => {
  for (const f of TRACKED) if (f in after) await logChange(t, id, prefix + f, before[f], after[f], reason);
};

async function bookingRefs(t: Tenant, b: Record<string, any>) {
  await t.refActive('clients', b.client_id, 'client'); await t.memberRef(b.agent_id, 'agent'); await t.ref('branches', b.branch_id, 'branch');
}

// ---------- list ----------
bookingsRouter.get('/', async (req, res) => {
  const t = T(req), s = scope(req, 'b', OWN), { status, q } = req.query as Record<string, string>, arch = req.query.archived === '1' ? 'AND b.archived_at IS NOT NULL' : 'AND b.archived_at IS NULL';
  res.json(await t.query(
    `SELECT b.id, b.reference, b.status, b.destination, b.travel_start, b.travel_end, b.currency, b.agent_id, b.client_id, b.quote_id, c.name client_name, u.name agent_name,
       (SELECT COALESCE(SUM(net_total),0) FROM booking_components k WHERE k.agency_id = b.agency_id AND k.booking_id = b.id) selling_net,
       (SELECT COALESCE(SUM(cost_total),0) FROM booking_components k WHERE k.agency_id = b.agency_id AND k.booking_id = b.id) cost
     FROM bookings b JOIN clients c ON c.id = b.client_id AND c.agency_id = b.agency_id LEFT JOIN users u ON u.id = b.agent_id
     WHERE b.agency_id = ?${s.sql} ${arch} ${status ? 'AND b.status = ?' : ''} ${q ? 'AND (b.reference LIKE ? OR b.destination LIKE ? OR c.name LIKE ?)' : ''} ORDER BY b.id DESC LIMIT 500`,
    [t.agencyId, ...s.params, ...(status ? [status] : []), ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])]));
});

// ---------- workspace ----------
const maskTraveller = (r: any) => { const { passport_enc, ...rest } = r; return { ...rest, passport: r.passport_last4 ? `••••${r.passport_last4}` : null, has_passport: !!passport_enc }; };

async function workspace(t: Tenant, id: number, b: any) {
  const a = t.agencyId;
  const [client, components, travellers, itinerary, changes, activities, tasks, invoices] = await Promise.all([
    t.get('clients', b.client_id),
    t.query(`SELECT k.*, s.name supplier_name FROM booking_components k LEFT JOIN suppliers s ON s.id = k.supplier_id AND s.agency_id = k.agency_id WHERE k.agency_id = ? AND k.booking_id = ? ORDER BY k.service_start, k.id`, [a, id]),
    t.query(`SELECT tr.id, tr.client_id, tr.first_name, tr.last_name, tr.dob, tr.nationality, tr.email, tr.phone, tr.passport_last4, tr.passport_enc, tr.passport_expiry, tr.notes, tr.emergency_contact, bt.room_group
             FROM booking_travellers bt JOIN travellers tr ON tr.id = bt.traveller_id AND tr.agency_id = bt.agency_id WHERE bt.agency_id = ? AND bt.booking_id = ? ORDER BY tr.last_name`, [a, id]),
    t.query(`SELECT * FROM itinerary_items WHERE agency_id = ? AND booking_id = ? ORDER BY day_no, sort, start_time`, [a, id]),
    t.query(`SELECT c.*, u.name user_name FROM booking_changes c LEFT JOIN users u ON u.id = c.user_id WHERE c.agency_id = ? AND c.booking_id = ? ORDER BY c.id DESC LIMIT 200`, [a, id]),
    t.query(`SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id = a.created_by WHERE a.agency_id = ? AND a.entity_type = 'booking' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 100`, [a, id]),
    t.query(`SELECT * FROM tasks WHERE agency_id = ? AND entity_type = 'booking' AND entity_id = ? ORDER BY status, due_at`, [a, id]),
    t.query(`SELECT id, number, status, currency, total, amount_paid, amount_credited, due_date FROM invoices WHERE agency_id = ? AND booking_id = ? ORDER BY id DESC`, [a, id]),
  ]);
  const sum = (k: string) => r2(components.reduce((s: number, c: any) => s + c[k], 0));
  const net = sum('net_total'), tax = sum('tax_total'), cost = sum('cost_total');
  const live = invoices.filter((i: any) => !['draft', 'void'].includes(i.status));
  const same = live.filter((i: any) => i.currency === b.currency);
  const invoiced = r2(same.reduce((s: number, i: any) => s + i.total - i.amount_credited, 0)), paid = r2(same.reduce((s: number, i: any) => s + i.amount_paid, 0)); // invoiced is net of credit notes
  const count = (col: string) => components.reduce((m: Record<string, number>, c: any) => ((m[c[col]] = (m[c[col]] ?? 0) + 1), m), {});
  return {
    ...b, client, components, travellers: travellers.map(maskTraveller), itinerary, changes, activities, tasks, invoices,
    finance: {
      currency: b.currency, selling_net: net, tax, selling_total: r2(net + tax), supplier_cost: cost, gross_margin: r2(net - cost), margin_pct: marginPct(net, cost),
      overhead: b.overhead, contribution: r2(net - cost - b.overhead), invoiced, paid, outstanding: r2(invoiced - paid), not_yet_invoiced: r2(Math.max(0, net + tax - invoiced)),
      other_currency_invoices: live.length - same.length,
      note: 'Margin = selling net − supplier cost. Booking value is not agency revenue; revenue recognition is defined in R3.',
    },
    // independent status dimensions — a booking can be confirmed, unpaid and unticketed at once
    statuses: {
      booking: b.status, supplier_confirmation: count('confirmation_status'), ticketing: count('ticketing_status'), fulfilment: count('fulfilment_status'),
      payment: invoiced === 0 ? 'not_invoiced' : paid >= invoiced ? 'paid' : paid > 0 ? 'part_paid' : 'unpaid',
    },
  };
}

bookingsRouter.get('/:id', async (req, res) => {
  const t = T(req), id = idParam(req), b = await findScoped(t, req, 'bookings', id, OWN);
  res.json(await workspace(t, id, b));
});

// ---------- create / update ----------
bookingsRouter.post('/', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(Booking, req.body), t = T(req);
  await assertWithinLimit(t.agencyId, 'bookings');
  if (req.ctx!.role === 'agent') b.agent_id = req.ctx!.userId; else b.agent_id ??= req.ctx!.userId;
  if (req.ctx!.branchId) b.branch_id = req.ctx!.branchId;
  await bookingRefs(t, b);
  const { reason, ...data } = b; void reason;
  const id = await t.tx(async (tx) => {
    const reference = data.reference ?? (await nextDocNo(tx, 'bookings', 'reference', 'BK'));
    const currency = data.currency ?? (await tx.agency()).base_currency;
    const bid = await tx.insert('bookings', { ...data, reference, currency });
    await tx.insert('activities', { entity_type: 'booking', entity_id: bid, kind: 'system', body: `Booking ${reference} created`, created_by: req.ctx!.userId });
    return bid;
  });
  res.status(201).json({ id });
});

const AGENT_MAY_ARCHIVE = ['enquiry', 'quoted', 'awaiting_client', 'on_hold', 'cancelled', 'lost'];
bookingsRouter.get('/:id/usage', async (req, res) => {
  const t = T(req), id = idParam(req); await findScoped(t, req, 'bookings', id, OWN);
  const deps = await dependents(t, 'booking_id', id, ['booking_components', 'booking_travellers', 'itinerary_items', 'commission_entries', 'commission_splits', 'commissions', 'support_requests']);
  const live = deps.filter((d) => ['invoices', 'supplier_bills'].includes(d.table)); res.json({ deps, live });
});
bookingsRouter.delete('/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), cur = await findScoped(t, req, 'bookings', id, OWN); assertCanEdit(req, cur, 'agent_id');
  if (req.ctx!.role === 'agent' && !AGENT_MAY_ARCHIVE.includes(cur.status)) throw new HttpError(403, 'Only finance or an admin can delete a confirmed booking. Ask them, or set it to Cancelled.');
  const reason = parse(z.object({ reason: z.string().trim().min(3, 'A reason is required').max(300) }), req.body ?? {}).reason;
  await archiveBooking(t, id, reason); await safeRecalc(t, id); res.json({ ok: true });
});
bookingsRouter.post('/:id/restore', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req); await restoreBooking(t, id, parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body ?? {}).reason); await safeRecalc(t, id); res.json({ ok: true });
});

bookingsRouter.put('/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), cur = await findScoped(t, req, 'bookings', id, OWN);
  assertCanEdit(req, cur, 'agent_id');
  if (cur.archived_at) throw new HttpError(409, 'This booking is archived — restore it before editing.');
  const { reason, ...b } = parse(Booking.partial(), req.body);
  if (req.ctx!.role === 'agent') delete b.agent_id;
  if (req.ctx!.branchId) delete b.branch_id;
  await bookingRefs(t, b);
  if (b.status && b.status !== cur.status) {
    if (NEEDS_REASON.includes(b.status) && !reason) throw new HttpError(400, `A reason is required to set status to ${b.status.replace('_', ' ')}`);
    if (TERMINAL.includes(cur.status) && (!reason || !WRITERS.includes(req.ctx!.role))) throw new HttpError(403, `A ${cur.status} booking can only be reopened by finance/admin with a reason`);
  }
  if (b.reference && b.reference !== cur.reference) throw new HttpError(400, 'Booking reference cannot be changed');
  await t.tx(async (tx) => { await diff(tx, id, cur, b, reason); await tx.update('bookings', id, b); });
  await safeRecalc(t, id);
  res.json({ ok: true });
});

// ---------- components ----------
const Component = z.object({
  product_type: z.enum(TYPES), supplier_id: nul(z.number().int()), supplier_ref: nul(z.string().max(80)), description: z.string().min(1).max(500),
  service_start: nul(z.string()), service_end: nul(z.string()), timezone: nul(z.string().max(50)), quantity: z.number().positive().default(1),
  unit_cost: z.number().min(0).default(0), markup_pct: z.number().min(0).default(0), discount_pct: z.number().min(0).max(100).default(0), tax_rate: z.number().min(0).default(0),
  commission_pct: nul(z.number().min(0).max(100)), cancellation_terms: nul(z.string()),
  confirmation_status: z.enum(['pending', 'requested', 'confirmed', 'waitlisted', 'cancelled']).optional(),
  ticketing_status: z.enum(['not_applicable', 'pending', 'ticketed']).optional(), fulfilment_status: z.enum(['pending', 'in_progress', 'done']).optional(), reason: z.string().max(300).optional(),
});
const CTRACK = ['supplier_id', 'supplier_ref', 'description', 'service_start', 'service_end', 'unit_cost', 'unit_price', 'net_total', 'cancellation_terms', 'confirmation_status', 'ticketing_status', 'fulfilment_status'];

async function editableBooking(req: any, id: number) {
  const t = T(req), b = await findScoped(t, req, 'bookings', id, OWN);
  assertCanEdit(req, b, 'agent_id');
  if (b.archived_at) throw new HttpError(409, 'This booking is archived — restore it before editing.');
  if (TERMINAL.includes(b.status)) throw new HttpError(409, `Booking is ${b.status}; reopen it first`);
  return b;
}

bookingsRouter.post('/:id/components', requireRole(...ALL_EDITORS), async (req, res) => {
  const id = idParam(req), t = T(req); await editableBooking(req, id);
  const { reason, ...c } = parse(Component, req.body); await t.refActive('suppliers', c.supplier_id, 'supplier');
  const cid = await t.tx(async (tx) => {
    const k = await tx.insert('booking_components', { ...c, booking_id: id, ...priceComponent(c), ticketing_status: c.ticketing_status ?? (c.product_type === 'flight' ? 'pending' : 'not_applicable') });
    await logChange(tx, id, `component#${k} added`, null, `${c.product_type}: ${c.description}`, reason);
    return k;
  });
  await safeRecalc(t, id);
  res.status(201).json({ id: cid });
});

bookingsRouter.put('/:id/components/:cid', requireRole(...ALL_EDITORS), async (req, res) => {
  const id = idParam(req), cid = Number(req.params.cid), t = T(req); await editableBooking(req, id);
  const cur = await t.one('SELECT * FROM booking_components WHERE agency_id = ? AND id = ? AND booking_id = ?', [t.agencyId, cid, id]);
  if (!cur) throw new HttpError(404, 'Component not found');
  const { reason, ...c } = parse(Component.partial(), req.body); await t.ref('suppliers', c.supplier_id, 'supplier');
  const merged = { ...cur, ...c }, priced = priceComponent(merged);
  await t.tx(async (tx) => {
    const next = { ...c, ...priced };
    for (const f of CTRACK) if (f in next) await logChange(tx, id, `component#${cid}.${f}`, cur[f], (next as any)[f], reason);
    await tx.update('booking_components', cid, next);
  });
  await safeRecalc(t, id);
  res.json({ ok: true });
});

bookingsRouter.delete('/:id/components/:cid', requireRole(...ALL_EDITORS), async (req, res) => {
  const id = idParam(req), cid = Number(req.params.cid), t = T(req); await editableBooking(req, id);
  const { reason } = parse(z.object({ reason: z.string().min(3, 'A reason is required to remove a component') }), req.query);
  const cur = await t.one('SELECT * FROM booking_components WHERE agency_id = ? AND id = ? AND booking_id = ?', [t.agencyId, cid, id]);
  if (!cur) throw new HttpError(404, 'Component not found');
  await t.tx(async (tx) => { await logChange(tx, id, `component#${cid} removed`, `${cur.product_type}: ${cur.description} (${cur.net_total})`, null, reason); await tx.remove('booking_components', cid); });
  res.json({ ok: true });
});

// ---------- travellers on a booking ----------
bookingsRouter.post('/:id/travellers', requireRole(...ALL_EDITORS), async (req, res) => {
  const id = idParam(req), t = T(req); await editableBooking(req, id);
  const b = parse(z.object({ traveller_id: z.number().int(), room_group: nul(z.string().max(40)) }), req.body);
  await t.ref('travellers', b.traveller_id, 'traveller');
  if (await t.one('SELECT id FROM booking_travellers WHERE agency_id = ? AND booking_id = ? AND traveller_id = ?', [t.agencyId, id, b.traveller_id])) throw new HttpError(409, 'Traveller already on this booking');
  await t.tx(async (tx) => { await tx.insert('booking_travellers', { booking_id: id, ...b }); await logChange(tx, id, 'traveller added', null, `#${b.traveller_id}`); });
  res.status(201).json({ ok: true });
});
bookingsRouter.delete('/:id/travellers/:tid', requireRole(...ALL_EDITORS), async (req, res) => {
  const id = idParam(req), tid = Number(req.params.tid), t = T(req); await editableBooking(req, id);
  const row = await t.one('SELECT id FROM booking_travellers WHERE agency_id = ? AND booking_id = ? AND traveller_id = ?', [t.agencyId, id, tid]);
  if (!row) throw new HttpError(404, 'Not on this booking');
  await t.tx(async (tx) => { await tx.remove('booking_travellers', row.id); await logChange(tx, id, 'traveller removed', `#${tid}`, null); });
  res.json({ ok: true });
});

// ---------- itinerary ----------
const Item = z.object({
  day_no: z.number().int().min(1).default(1), day_date: nul(z.string()), start_time: nul(z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/)), timezone: nul(z.string().max(50)),
  title: z.string().min(1).max(200), description: nul(z.string()), location: nul(z.string().max(250)), supplier_id: nul(z.number().int()), component_id: nul(z.number().int()),
  confirmed: z.boolean().default(false), sort: z.number().int().default(0),
});
async function itemRefs(t: Tenant, bookingId: number, i: Record<string, any>) {
  await t.ref('suppliers', i.supplier_id, 'supplier');
  if (i.component_id && !(await t.one('SELECT id FROM booking_components WHERE agency_id = ? AND id = ? AND booking_id = ?', [t.agencyId, i.component_id, bookingId]))) throw new HttpError(400, 'Unknown component');
}
bookingsRouter.post('/:id/itinerary', requireRole(...ALL_EDITORS), async (req, res) => {
  const id = idParam(req), t = T(req); await editableBooking(req, id);
  const i = parse(Item, req.body); await itemRefs(t, id, i);
  res.status(201).json({ id: await t.insert('itinerary_items', { ...i, confirmed: i.confirmed ? 1 : 0, booking_id: id }) });
});
bookingsRouter.put('/:id/itinerary/:iid', requireRole(...ALL_EDITORS), async (req, res) => {
  const id = idParam(req), iid = Number(req.params.iid), t = T(req); await editableBooking(req, id);
  if (!(await t.one('SELECT id FROM itinerary_items WHERE agency_id = ? AND id = ? AND booking_id = ?', [t.agencyId, iid, id]))) throw new HttpError(404, 'Not found');
  const i = parse(Item.partial(), req.body); await itemRefs(t, id, i);
  await t.update('itinerary_items', iid, { ...i, ...(i.confirmed !== undefined ? { confirmed: i.confirmed ? 1 : 0 } : {}) }); res.json({ ok: true });
});
bookingsRouter.delete('/:id/itinerary/:iid', requireRole(...ALL_EDITORS), async (req, res) => {
  const id = idParam(req), iid = Number(req.params.iid), t = T(req); await editableBooking(req, id);
  if (!(await t.one('SELECT id FROM itinerary_items WHERE agency_id = ? AND id = ? AND booking_id = ?', [t.agencyId, iid, id]))) throw new HttpError(404, 'Not found');
  await t.remove('itinerary_items', iid); res.json({ ok: true });
});

// =====================  Travellers (directory)  =====================
const Traveller = z.object({
  client_id: nul(z.number().int()), first_name: z.string().min(1).max(100), last_name: z.string().min(1).max(100), dob: nul(z.string()), nationality: nul(z.string().max(60)),
  email: nul(z.string().email()), phone: nul(z.string().max(50)), passport_no: nul(z.string().min(4).max(30)), passport_expiry: nul(z.string()),
  notes: nul(z.string().max(500)), emergency_contact: nul(z.string().max(300)),
});
const toRow = (b: z.infer<typeof Traveller>) => {
  const { passport_no, ...rest } = b;
  return { ...rest, ...(passport_no ? { passport_enc: encrypt(passport_no), passport_last4: passport_no.slice(-4) } : {}) };
};

travellersRouter.get('/', async (req, res) => {
  const t = T(req), q = req.query.q ? `%${req.query.q}%` : null, agent = req.ctx!.role === 'agent';
  // agents only see travellers they created or who are on their own bookings
  res.json((await t.query(
    `SELECT DISTINCT tr.* FROM travellers tr LEFT JOIN booking_travellers bt ON bt.traveller_id = tr.id AND bt.agency_id = tr.agency_id LEFT JOIN bookings b ON b.id = bt.booking_id AND b.agency_id = bt.agency_id
     WHERE tr.agency_id = ? ${agent ? 'AND (tr.created_by = ? OR b.agent_id = ?)' : ''} ${q ? 'AND (tr.first_name LIKE ? OR tr.last_name LIKE ?)' : ''} ORDER BY tr.last_name LIMIT 300`,
    [t.agencyId, ...(agent ? [req.ctx!.userId, req.ctx!.userId] : []), ...(q ? [q, q] : [])])).map(maskTraveller));
});
travellersRouter.post('/', requireRole(...ALL_EDITORS), async (req, res) => {
  const b = parse(Traveller, req.body), t = T(req); await t.ref('clients', b.client_id, 'client');
  res.status(201).json({ id: await t.insert('travellers', { ...toRow(b), created_by: req.ctx!.userId }) });
});
travellersRouter.put('/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), cur = await t.get('travellers', id);
  if (!cur || (req.ctx!.role === 'agent' && cur.created_by !== req.ctx!.userId)) throw new HttpError(404, 'Not found');
  const b = parse(Traveller.partial(), req.body); await t.ref('clients', b.client_id, 'client');
  const { passport_no, ...rest } = b;
  await t.update('travellers', id, { ...rest, ...(passport_no ? { passport_enc: encrypt(passport_no), passport_last4: passport_no.slice(-4) } : {}) });
  res.json({ ok: true });
});
// Full passport number: finance/admin only; every reveal is recorded as a security event.
travellersRouter.get('/:id/passport', requireRole('admin', 'finance_manager'), async (req, res) => {
  const t = T(req), id = idParam(req), tr = await t.get('travellers', id);
  if (!tr?.passport_enc) throw new HttpError(404, 'No passport on file');
  await pool.query('INSERT INTO security_events (agency_id, user_id, ip, event, detail) VALUES (?,?,?,?,?)', [t.agencyId, req.ctx!.userId, req.ip, 'sensitive_view', `passport traveller#${id}`]);
  res.json({ passport_no: decrypt(tr.passport_enc), expiry: tr.passport_expiry });
});
