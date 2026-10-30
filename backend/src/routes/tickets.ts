import { Router } from 'express';
import { z } from 'zod';
import { ALL_EDITORS, HttpError, WRITERS, requireRole } from '../auth.js';
import { Tenant } from '../db.js';
import { nextDocNo, postVoucher, sysAccount, unpostVoucher } from '../services/accounting.js';
import { r2, today } from '../services/money.js';
import { idParam, parse, T } from './util.js';

export const ticketsRouter = Router();

const N = z.preprocess((v) => (v === '' || v == null ? 0 : Number(v)), z.number());
const S = z.string().nullish().transform((v) => (v === '' ? null : v ?? null));
const ID = z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().int().nullable());

const NUMS = ['fare', 'fare_nc', 'sp_yi', 'rg_cvt', 'yq', 'ced', 'pb_adv_yq', 'xz', 'yd', 'kb', 'xt_ur_us', 'other_tax', 'com_rec_pct', 'com_rec', 'com_paid_pct', 'com_paid',
  'wh_air', 'insurance', 'vat_paid', 'psf', 'other_charges', 'discount_pct', 'discount', 'wh_client', 'fare_inc', 'taxes_inc', 'agent_amount', 'vat_pct', 'vat'] as const;
const STRS = ['mode', 'line_type', 'passport', 'passenger_name', 'pax_type', 'nationality', 'phone_rt', 'group_no', 'ticket_no', 'con_ticket_no', 'ticket_type', 'sector', 'gds', 'route', 'pnr', 'gds_pnr',
  'fare_class', 'xo', 'dep_date', 'return_date', 'confirmation_no', 'currency'] as const;

const Line = z.object({
  ...Object.fromEntries(NUMS.map((k) => [k, N])), ...Object.fromEntries(STRS.map((k) => [k, S])),
  payable_account_id: ID, airline_id: ID, agent_account_id: ID,
  fx_rate: z.preprocess((v) => (v === '' || v == null || Number(v) <= 0 ? 1 : Number(v)), z.number()),
}) as unknown as z.ZodType<Record<string, any>>;

/**
 * Line maths (mirrors the legacy form):
 *  total_taxes = SP+YI, RG/CVT, YQ, CED, PB/Adv YQ, XZ, YD, KB, XT/UR/US, Other Tax
 *  ticket      = Fare + Fare NC + total_taxes
 *  payable     = ticket − Com Rec + WH Air + Insurance + VAT Paid           (owed to vendor/airline)
 *  receivable  = Fare Inc + Taxes Inc + PSF + Other − Discount + WH Client + VAT   (owed by client)
 *  profit      = receivable − payable − Com Paid − Agent Amount
 * Percentages, when given, override the matching amount. Amounts are in the line currency; fx_rate converts to base for posting.
 */
export function computeLine(l: Record<string, any>, airline?: { wh_pct?: number | null }) {
  const total_taxes = r2(l.sp_yi + l.rg_cvt + l.yq + l.ced + l.pb_adv_yq + l.xz + l.yd + l.kb + l.xt_ur_us + l.other_tax);
  const ticket_total = r2(l.fare + l.fare_nc + total_taxes);
  const com_rec = l.com_rec_pct > 0 ? r2((l.fare * l.com_rec_pct) / 100) : l.com_rec;
  const com_paid = l.com_paid_pct > 0 ? r2((l.fare * l.com_paid_pct) / 100) : l.com_paid;
  const wh_air = l.wh_air > 0 ? l.wh_air : airline?.wh_pct ? r2((com_rec * airline.wh_pct) / 100) : 0;
  const fare_inc = l.fare_inc > 0 ? l.fare_inc : r2(l.fare + l.fare_nc);
  const taxes_inc = l.taxes_inc > 0 ? l.taxes_inc : total_taxes;
  const discount = l.discount_pct > 0 ? r2((fare_inc * l.discount_pct) / 100) : l.discount;
  const vat = l.vat_pct > 0 ? r2(((l.psf + l.other_charges) * l.vat_pct) / 100) : l.vat;
  const receivable_fc = r2(fare_inc + taxes_inc + l.psf + l.other_charges - discount + l.wh_client + vat);
  const payable_fc = r2(ticket_total - com_rec + wh_air + l.insurance + l.vat_paid);
  const profit_fc = r2(receivable_fc - payable_fc - com_paid - l.agent_amount);
  const rate = l.fx_rate > 0 ? l.fx_rate : 1;
  return { total_taxes, ticket_total, com_rec, com_paid, wh_air, fare_inc, taxes_inc, discount, vat, payable_fc, receivable_fc, profit_fc,
    payable: r2(payable_fc * rate), receivable: r2(receivable_fc * rate), profit: r2(profit_fc * rate) };
}

ticketsRouter.post('/calc', async (req, res) => {
  const t = T(req); const l = parse(Line, req.body);
  const airline = l.airline_id ? await t.get('airlines', l.airline_id) : undefined;
  res.json(computeLine(l, airline));
});

const Header = z.object({
  branch_id: ID, department_id: ID, invoice_date: z.string().default(() => today()), due_date: S, due_vendor: S,
  stax_invoice_no: S, ref_no: S, client_account_id: z.number().int(), payment_terms: S, employee_id: ID, remarks: S,
  umrah_query_id: S, ticket_query_id: S, status: z.enum(['tentative', 'confirmed']).default('tentative'), active: z.boolean().default(true),
  lines: z.array(Line).min(1),
});

async function checkHeaderRefs(t: Tenant, h: Record<string, any>) {
  await t.ref('accounts', h.client_account_id, 'client account');
  await t.ref('branches', h.branch_id, 'branch'); await t.ref('departments', h.department_id, 'department'); await t.memberRef(h.employee_id, 'employee');
}
async function checkLineRefs(t: Tenant, lines: Record<string, any>[]) {
  for (const l of lines) { await t.ref('airlines', l.airline_id, 'airline'); await t.ref('accounts', l.payable_account_id, 'payable account'); await t.ref('accounts', l.agent_account_id, 'agent account'); }
}
/** Branch-scoped users only see/act on their own branch's documents (404 otherwise, never revealing existence). */
const inBranch = (req: any, branchId: number | null) => !req.ctx.branchId || branchId === req.ctx.branchId;

async function load(t: Tenant, id: number) {
  const inv = await t.one(
    `SELECT i.*, c.name client_name, c.code client_code FROM ticket_invoices i JOIN accounts c ON c.id = i.client_account_id AND c.agency_id = i.agency_id WHERE i.agency_id = ? AND i.id = ?`, [t.agencyId, id]);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const lines = await t.query(
    `SELECT l.*, a.name payable_name, al.name airline_name FROM ticket_lines l LEFT JOIN accounts a ON a.id = l.payable_account_id AND a.agency_id = l.agency_id LEFT JOIN airlines al ON al.id = l.airline_id AND al.agency_id = l.agency_id
     WHERE l.agency_id = ? AND l.invoice_id = ? ORDER BY l.id`, [t.agencyId, id]);
  return { ...inv, lines };
}

async function saveLines(t: Tenant, invoiceId: number, lines: Record<string, any>[]) {
  await t.query('DELETE FROM ticket_lines WHERE agency_id = ? AND invoice_id = ?', [t.agencyId, invoiceId]);
  for (const l of lines) {
    const airline = l.airline_id ? await t.get('airlines', l.airline_id) : undefined;
    if (!l.payable_account_id && airline?.account_id) l.payable_account_id = airline.account_id;
    if (!l.payable_account_id) throw new HttpError(400, 'Payable Code is required on every line');
    const c = computeLine(l, airline);
    l.mode ??= 'ticket'; l.line_type ??= 'Normal'; l.pax_type ??= 'Adult'; // NOT NULL columns with defaults
    await t.insert('ticket_lines', { ...l, invoice_id: invoiceId, ...c });
  }
}

/** GL posting: one voucher per invoice. Dr client, Dr commission expense, Cr vendor, Cr agent, Cr/Dr sales (balancing margin). */
async function postInvoice(t: Tenant, invoiceId: number) {
  const inv = await load(t, invoiceId);
  await unpostVoucher(t, inv.voucher_id);
  const sales = await sysAccount(t, 'sales'), comm = await sysAccount(t, 'commission_paid');
  const legs: any[] = [];
  for (const l of inv.lines) {
    const rate = l.fx_rate > 0 ? l.fx_rate : 1, who = `${l.passenger_name ?? ''} ${l.ticket_no ? '/ ' + l.ticket_no : ''}`.trim();
    const comPaid = r2(l.com_paid * rate), agent = r2(l.agent_amount * rate);
    legs.push({ account_id: inv.client_account_id, debit: l.receivable, narration: `${inv.invoice_no} ${who}` });
    legs.push({ account_id: l.payable_account_id, credit: l.payable, narration: `${inv.invoice_no} ${who}` });
    if (comPaid) legs.push({ account_id: comm, debit: comPaid, narration: `Com paid ${who}` });
    if (agent && l.agent_account_id) {
      legs.push({ account_id: comm, debit: agent, narration: `Agent com ${who}` });
      legs.push({ account_id: l.agent_account_id, credit: agent, narration: `Agent com ${who}` });
    }
    legs.push({ account_id: sales, credit: r2(l.receivable + comPaid - l.payable), narration: `Sale ${who}` });
  }
  const vid = await postVoucher(t, { type: 'ticket_invoice', date: inv.invoice_date, narration: `Ticket invoice ${inv.invoice_no}`, ref_table: 'ticket_invoices', ref_id: invoiceId, legs });
  await t.update('ticket_invoices', invoiceId, { voucher_id: vid });
}

ticketsRouter.get('/invoices', async (req, res) => {
  const t = T(req), { q, from, to, status } = req.query as Record<string, string>;
  const agent = req.ctx!.role === 'agent';
  res.json(await t.query(
    `SELECT i.*, c.name client_name, c.code client_code, (SELECT COUNT(*) FROM ticket_lines l WHERE l.agency_id = i.agency_id AND l.invoice_id = i.id) n_lines,
       (SELECT COALESCE(SUM(receivable),0) FROM ticket_lines l WHERE l.agency_id = i.agency_id AND l.invoice_id = i.id) receivable,
       (SELECT COALESCE(SUM(profit),0) FROM ticket_lines l WHERE l.agency_id = i.agency_id AND l.invoice_id = i.id) profit
     FROM ticket_invoices i JOIN accounts c ON c.id = i.client_account_id AND c.agency_id = i.agency_id
     WHERE i.agency_id = ? ${status ? 'AND i.status = ?' : ''} ${from ? 'AND i.invoice_date >= ?' : ''} ${to ? 'AND i.invoice_date <= ?' : ''}
     ${q ? 'AND (i.invoice_no LIKE ? OR c.name LIKE ?)' : ''} ${agent ? 'AND i.created_by = ?' : ''} ${req.ctx!.branchId ? 'AND i.branch_id = ?' : ''} ORDER BY i.id DESC LIMIT 500`,
    [t.agencyId, ...(status ? [status] : []), ...(from ? [from] : []), ...(to ? [to] : []), ...(q ? [`%${q}%`, `%${q}%`] : []), ...(agent ? [req.ctx!.userId] : []), ...(req.ctx!.branchId ? [req.ctx!.branchId] : [])]));
});

async function loadScoped(req: any, id: number) {
  const inv = await load(T(req), id);
  if (!inBranch(req, inv.branch_id)) throw new HttpError(404, 'Invoice not found');
  return inv;
}

ticketsRouter.get('/invoices/:id', async (req, res) => res.json(await loadScoped(req, idParam(req))));

ticketsRouter.post('/invoices', requireRole(...ALL_EDITORS), async (req, res) => {
  const { lines, ...h } = parse(Header, req.body); const t = T(req);
  if (req.ctx!.branchId) h.branch_id = req.ctx!.branchId; // branch-scoped users always file under their branch
  await checkHeaderRefs(t, h); await checkLineRefs(t, lines);
  const id = await t.tx(async (tx) => {
    const invoice_no = await nextDocNo(tx, 'ticket_invoices', 'invoice_no', 'TK');
    const invId = await tx.insert('ticket_invoices', {
      ...h, active: h.active ? 1 : 0, invoice_no, created_by: req.ctx!.userId, status: 'tentative', employee_id: h.employee_id ?? req.ctx!.userId,
      due_date: h.due_date ?? h.invoice_date,
    });
    await saveLines(tx, invId, lines);
    return invId;
  });
  res.status(201).json(await load(t, id));
});

ticketsRouter.put('/invoices/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req), { lines, ...h } = parse(Header, req.body);
  const cur = await t.get('ticket_invoices', id);
  if (!cur || !inBranch(req, cur.branch_id)) throw new HttpError(404, 'Not found');
  if (req.ctx!.branchId) h.branch_id = req.ctx!.branchId;
  await checkHeaderRefs(t, h); await checkLineRefs(t, lines);
  if (req.ctx!.role === 'agent' && (cur.created_by !== req.ctx!.userId || cur.supervised)) throw new HttpError(403, 'Agents can only edit their own unsupervised invoices');
  await t.tx(async (tx) => {
    await tx.update('ticket_invoices', id, { ...h, active: h.active ? 1 : 0, status: cur.status });
    await saveLines(tx, id, lines);
    if (cur.supervised) await postInvoice(tx, id); // keep ledger in step with edits
  });
  res.json(await load(t, id));
});

// "Supervise" = approve: confirms the invoice and posts it to the ledger.
ticketsRouter.post('/invoices/:id/supervise', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const inv = await t.get('ticket_invoices', id);
  if (!inv || !inBranch(req, inv.branch_id)) throw new HttpError(404, 'Not found');
  await t.tx(async (tx) => { await postInvoice(tx, id); await tx.update('ticket_invoices', id, { supervised: 1, status: 'confirmed' }); });
  res.json({ status: 'confirmed' });
});

ticketsRouter.post('/invoices/:id/repost', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const inv = await t.get('ticket_invoices', id);
  if (!inv || !inBranch(req, inv.branch_id)) throw new HttpError(404, 'Not found');
  if (!inv.supervised) throw new HttpError(409, 'Only supervised invoices are posted');
  await t.tx((tx) => postInvoice(tx, id));
  res.json({ ok: true });
});

ticketsRouter.post('/invoices/set-all-active', requireRole(...WRITERS), async (req, res) => {
  const t = T(req);
  await t.query('UPDATE ticket_invoices SET active = 1 WHERE agency_id = ?', [t.agencyId]);
  res.json({ ok: true });
});

ticketsRouter.delete('/invoices/:id', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const inv = await t.get('ticket_invoices', id);
  if (!inv || !inBranch(req, inv.branch_id)) throw new HttpError(404, 'Not found');
  if (await t.one('SELECT id FROM refunds WHERE agency_id = ? AND invoice_id = ? LIMIT 1', [t.agencyId, id])) throw new HttpError(409, 'Invoice has refunds');
  await t.tx(async (tx) => {
    await unpostVoucher(tx, inv.voucher_id);
    await tx.query('DELETE FROM ticket_lines WHERE agency_id = ? AND invoice_id = ?', [t.agencyId, id]);
    await tx.remove('ticket_invoices', id);
  });
  res.json({ ok: true });
});

// ---- Ticket search (Ticket tab / Confirmation tab) ----
ticketsRouter.get('/search', async (req, res) => {
  const t = T(req); const { ticket_no, passenger, confirmation_no } = req.query as Record<string, string>;
  const conds: string[] = [], p: any[] = [t.agencyId];
  if (ticket_no) { conds.push('l.ticket_no LIKE ?'); p.push(`%${ticket_no}%`); }
  if (passenger) { conds.push('l.passenger_name LIKE ?'); p.push(`%${passenger}%`); }
  if (confirmation_no) { conds.push('l.confirmation_no LIKE ?'); p.push(`%${confirmation_no}%`); }
  if (!conds.length) return void res.json([]);
  res.json(await t.query(
    `SELECT l.id, l.invoice_id, i.invoice_no, l.ticket_no, l.passenger_name, l.sector, l.route, l.confirmation_no, l.receivable, EXISTS(SELECT 1 FROM refunds r WHERE r.agency_id = l.agency_id AND r.ticket_line_id = l.id) refunded
     FROM ticket_lines l JOIN ticket_invoices i ON i.id = l.invoice_id AND i.agency_id = l.agency_id WHERE l.agency_id = ? AND ${conds.join(' AND ')} ORDER BY l.id DESC LIMIT 100`, p));
});

// ---- Refunds ----
const RefundIn = z.object({
  refund_date: z.string().default(() => today()), ticket_line_id: ID, invoice_id: ID, branch_id: ID, department_id: ID, employee_id: ID,
  client_account_id: z.number().int(), payable_account_id: z.number().int(),
  mode: S, passport: S, passenger: S, pax_type: S, date_of_issue: S, date_of_expiry: S, cnic: S, father_name: S, group_no: S,
  hotel: S, rooms_par: S, room_no: S, room_qty: ID, nights: ID, meal: S, check_out: S, rate_night: N, confirmation_no: S, internal_ref: S, particulars: S,
  amount: N, com_rec: N, com_paid: N, wh_air: N, vat: N, discount: N, cancelation: N, service: N, rec_from_vendor: N, pay_to_customer: N,
  currency: S, fx_rate: z.preprocess((v) => (v === '' || v == null || Number(v) <= 0 ? 1 : Number(v)), z.number()), agent_account_id: ID, agent_amount: N,
  pending: z.boolean().default(false),
}) as unknown as z.ZodType<Record<string, any>>;

ticketsRouter.get('/refund-prefill/:lineId', async (req, res) => {
  const t = T(req);
  const l = await t.get('ticket_lines', idParam({ params: { id: req.params.lineId } } as any));
  if (!l) throw new HttpError(404, 'Ticket not found');
  const inv = await t.get('ticket_invoices', l.invoice_id);
  res.json({
    ticket_line_id: l.id, invoice_id: l.invoice_id, client_account_id: inv.client_account_id, payable_account_id: l.payable_account_id,
    branch_id: inv.branch_id, department_id: inv.department_id, mode: l.mode, passport: l.passport, passenger: l.passenger_name, pax_type: l.pax_type,
    group_no: l.group_no, confirmation_no: l.confirmation_no, amount: l.receivable_fc, rec_from_vendor: l.payable_fc, currency: l.currency, fx_rate: l.fx_rate,
    com_rec: l.com_rec, com_paid: l.com_paid, wh_air: l.wh_air, vat: l.vat, discount: l.discount, ticket_no: l.ticket_no,
  });
});

ticketsRouter.get('/refunds', async (req, res) => {
  const t = T(req);
  res.json(await t.query(
    `SELECT r.*, c.name client_name, v.name vendor_name FROM refunds r JOIN accounts c ON c.id = r.client_account_id AND c.agency_id = r.agency_id JOIN accounts v ON v.id = r.payable_account_id AND v.agency_id = r.agency_id
     WHERE r.agency_id = ? ORDER BY r.id DESC LIMIT 300`, [t.agencyId]));
});
ticketsRouter.get('/refunds/:id', async (req, res) => {
  const r = await T(req).get('refunds', idParam(req)); if (!r) throw new HttpError(404, 'Not found'); res.json(r);
});

async function postRefund(t: Tenant, id: number) {
  const r = await t.get('refunds', id);
  await unpostVoucher(t, r.voucher_id);
  if (r.pending) return t.update('refunds', id, { voucher_id: null });
  const svc = await sysAccount(t, 'service_charges'), rate = r.fx_rate > 0 ? r.fx_rate : 1;
  const V = r2(r.rec_from_vendor * rate), C = r2(r.pay_to_customer * rate);
  // Dr vendor (we get money back), Cr client (we owe them), balance = service/cancellation income (Cr) or loss (Dr)
  const vid = await postVoucher(t, {
    type: 'refund', date: r.refund_date, narration: `Refund ${r.refund_no} ${r.passenger ?? ''}`.trim(), ref_table: 'refunds', ref_id: id,
    legs: [{ account_id: r.payable_account_id, debit: V }, { account_id: r.client_account_id, credit: C }, { account_id: svc, credit: r2(V - C) }],
  });
  await t.update('refunds', id, { voucher_id: vid });
}

function refundMaths(b: Record<string, any>) {
  const pay_to_customer = b.pay_to_customer > 0 ? b.pay_to_customer : r2(Math.max(0, b.amount - b.cancelation - b.service));
  return { pay_to_customer, profit: r2(b.rec_from_vendor - pay_to_customer), difference: r2(b.amount - pay_to_customer - b.cancelation - b.service) };
}

async function checkRefundRefs(t: Tenant, b: Record<string, any>) {
  await t.ref('ticket_lines', b.ticket_line_id, 'ticket'); await t.ref('ticket_invoices', b.invoice_id, 'invoice');
  await t.ref('accounts', b.client_account_id, 'client account'); await t.ref('accounts', b.payable_account_id, 'payable account'); await t.ref('accounts', b.agent_account_id, 'agent account');
  await t.ref('branches', b.branch_id, 'branch'); await t.ref('departments', b.department_id, 'department'); await t.memberRef(b.employee_id, 'employee');
}

ticketsRouter.post('/refunds', requireRole(...WRITERS), async (req, res) => {
  const b = parse(RefundIn, req.body); const t = T(req);
  await checkRefundRefs(t, b);
  if (await t.one('SELECT id FROM refunds WHERE agency_id = ? AND ticket_line_id = ? AND ? IS NOT NULL LIMIT 1', [t.agencyId, b.ticket_line_id, b.ticket_line_id])) throw new HttpError(409, 'This ticket is already refunded');
  const id = await t.tx(async (tx) => {
    const refund_no = await nextDocNo(tx, 'refunds', 'refund_no', 'RF');
    const rid = await tx.insert('refunds', { ...b, ...refundMaths(b), pending: b.pending ? 1 : 0, refund_no, created_by: req.ctx!.userId });
    await postRefund(tx, rid);
    return rid;
  });
  res.status(201).json(await t.get('refunds', id));
});

ticketsRouter.put('/refunds/:id', requireRole(...WRITERS), async (req, res) => {
  const b = parse(RefundIn, req.body); const t = T(req), id = idParam(req);
  await checkRefundRefs(t, b);
  await t.tx(async (tx) => { await tx.update('refunds', id, { ...b, ...refundMaths(b), pending: b.pending ? 1 : 0 }); await postRefund(tx, id); });
  res.json(await t.get('refunds', id));
});

ticketsRouter.delete('/refunds/:id', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req); const r = await t.get('refunds', id);
  if (!r) throw new HttpError(404, 'Not found');
  await t.tx(async (tx) => { await unpostVoucher(tx, r.voucher_id); await tx.remove('refunds', id); });
  res.json({ ok: true });
});

// ---- Sale reports ----
ticketsRouter.get('/reports/sales', requireRole('admin', 'finance_manager', 'viewer'), async (req, res) => {
  const t = T(req); const group = String(req.query.group ?? 'airline');
  const from = String(req.query.from ?? `${new Date().getUTCFullYear()}-01-01`), to = String(req.query.to ?? today());
  const key = ({
    airline: ["COALESCE(al.name, p.name)", 'LEFT JOIN airlines al ON al.id = l.airline_id AND al.agency_id = l.agency_id'], client: ['c.name', ''], date: ['i.invoice_date', ''],
    employee: ["COALESCE(u.name,'—')", 'LEFT JOIN memberships mm ON mm.user_id = i.employee_id AND mm.agency_id = i.agency_id LEFT JOIN users u ON u.id = mm.user_id'], branch: ["COALESCE(b.name,'—')", 'LEFT JOIN branches b ON b.id = i.branch_id AND b.agency_id = i.agency_id'],
  } as Record<string, [string, string]>)[group];
  if (!key) throw new HttpError(400, 'group must be airline, client, date, employee or branch');
  const rows = await t.query(
    `SELECT ${key[0]} label, COUNT(*) tickets, SUM(l.fare * l.fx_rate) fare, SUM(l.total_taxes * l.fx_rate) taxes, SUM(l.receivable) receivable, SUM(l.payable) payable, SUM(l.profit) profit
     FROM ticket_lines l JOIN ticket_invoices i ON i.id = l.invoice_id AND i.agency_id = l.agency_id JOIN accounts c ON c.id = i.client_account_id AND c.agency_id = i.agency_id JOIN accounts p ON p.id = l.payable_account_id AND p.agency_id = l.agency_id ${key[1]}
     WHERE l.agency_id = ? AND i.status = 'confirmed' AND i.invoice_date BETWEEN ? AND ? GROUP BY label ORDER BY receivable DESC`, [t.agencyId, from, to]);
  res.json({ group, from, to, rows });
});
