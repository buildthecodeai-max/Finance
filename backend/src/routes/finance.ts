import { Router } from 'express';
import { z } from 'zod';
import { WRITERS, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { BALANCE_SQL } from '../services/accounting.js';
import * as F from '../services/finance.js';
import * as PR from '../services/payment-runs.js';
import { fileKey, putFile, signedUrl } from '../storage.js';
import { htmlToPdf } from '../services/pdf.js';
import { r2, today } from '../services/money.js';
import { idParam, parse, T } from './util.js';

export const financeRouter = Router();
financeRouter.use(requireRole('admin', 'finance_manager', 'viewer'));   // agents have no access to finance records
const W = requireRole(...WRITERS);
const METHOD = z.enum(['bank_transfer', 'stripe', 'direct_debit', 'cash']);
const Alloc = z.object({ invoice_id: z.number().int(), amount: z.number().positive() });
const Reason = z.object({ reason: z.string().optional().default(''), date: z.string().optional() });

// ---------------------------------------------------------------- overview, aging, reconciliation
const BUCKETS = `SUM(CASE WHEN due_date >= CURDATE() THEN b ELSE 0 END) current_, SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 1 AND 30 THEN b ELSE 0 END) d30,
  SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 31 AND 60 THEN b ELSE 0 END) d60, SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) BETWEEN 61 AND 90 THEN b ELSE 0 END) d90,
  SUM(CASE WHEN DATEDIFF(CURDATE(),due_date) > 90 THEN b ELSE 0 END) d90p, COALESCE(SUM(b),0) total, COUNT(*) n`;

financeRouter.get('/summary', async (req, res) => {
  const t = T(req), a = t.agencyId;
  const [ar, ap, cash, unalloc, pendingRefunds, dueBills, overdueInv, recMonth, unposted, glAr, subAr] = await Promise.all([
    t.one(`SELECT ${BUCKETS} FROM (SELECT due_date, (total - amount_credited - amount_paid) * fx_rate b FROM invoices WHERE agency_id = ? AND voucher_id IS NOT NULL AND status NOT IN ('void','draft','reviewed') AND total - amount_credited - amount_paid > 0.005) x`, [a]),
    t.one(`SELECT ${BUCKETS} FROM (SELECT due_date, (total - amount_paid) * fx_rate b FROM supplier_bills WHERE agency_id = ? AND status IN ('approved','partially_paid') AND total - amount_paid > 0.005) x`, [a]),
    t.query(`SELECT a.id, a.name, ${BALANCE_SQL} balance FROM accounts a WHERE a.agency_id = ? AND a.type_code = 110 ORDER BY a.code`, [a]),
    t.one(`SELECT COALESCE(SUM(unallocated * fx_rate),0) v, COUNT(*) n FROM receipts WHERE agency_id = ? AND status = 'posted' AND unallocated > 0.005`, [a]),
    t.one(`SELECT COUNT(*) n, COALESCE(SUM(amount * fx_rate),0) v FROM client_refunds WHERE agency_id = ? AND status IN ('requested','approved')`, [a]),
    t.one(`SELECT COUNT(*) n, COALESCE(SUM((total - amount_paid) * fx_rate),0) v FROM supplier_bills WHERE agency_id = ? AND status IN ('approved','partially_paid') AND due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 14 DAY)`, [a]),
    t.one(`SELECT COUNT(*) n FROM invoices WHERE agency_id = ? AND voucher_id IS NOT NULL AND status IN ('sent','partially_paid','overdue') AND due_date < CURDATE() AND total - amount_credited - amount_paid > 0.005`, [a]),
    t.one(`SELECT COALESCE(SUM(amount * fx_rate),0) v FROM receipts WHERE agency_id = ? AND status = 'posted' AND receipt_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`, [a]),
    t.one(`SELECT COUNT(*) n FROM invoices WHERE agency_id = ? AND voucher_id IS NULL AND status IN ('sent','partially_paid','paid','overdue','credited')`, [a]),
    t.one(`SELECT COALESCE(SUM(${BALANCE_SQL}),0) v FROM accounts a JOIN clients c ON c.account_id = a.id AND c.agency_id = a.agency_id WHERE a.agency_id = ?`, [a]),
    t.one(`SELECT COALESCE((SELECT SUM((total - amount_credited - amount_paid) * fx_rate) FROM invoices WHERE agency_id = ? AND voucher_id IS NOT NULL AND status <> 'void'),0)
                - COALESCE((SELECT SUM(unallocated * fx_rate) FROM receipts WHERE agency_id = ? AND status = 'posted'),0) v`, [a, a]),
  ]);
  const apGl = await t.one(`SELECT COALESCE(SUM(${BALANCE_SQL}),0) v FROM accounts a JOIN suppliers s ON s.account_id = a.id AND s.agency_id = a.agency_id WHERE a.agency_id = ?`, [a]);
  const apSub = await t.one(`SELECT COALESCE(SUM((total - amount_paid) * fx_rate),0) v FROM supplier_bills WHERE agency_id = ? AND voucher_id IS NOT NULL AND status <> 'void'`, [a]);
  const diffAr = r2(glAr!.v - subAr!.v), diffAp = r2(-apGl!.v - apSub!.v); // GL: receivable is a debit balance, payable a credit balance
  res.json({
    base_currency: (await t.agency()).base_currency,
    ar, ap, cash, cash_total: r2(cash.reduce((s: number, c: any) => s + c.balance, 0)),
    unallocated_receipts: unalloc, pending_refunds: pendingRefunds, bills_due_14d: dueBills, overdue_invoices: overdueInv!.n, receipts_30d: recMonth!.v,
    reconciliation: {
      ar: { ledger: r2(glAr!.v), subledger: r2(subAr!.v), difference: diffAr, ok: Math.abs(diffAr) <= 0.05 },
      ap: { ledger: r2(-apGl!.v), subledger: r2(apSub!.v), difference: diffAp, ok: Math.abs(diffAp) <= 0.05 },
      unposted_invoices: unposted!.n,
    },
  });
});

financeRouter.get('/ap-aging', async (req, res) => {
  const t = T(req);
  res.json(await t.query(
    `SELECT b.id, b.bill_no, b.supplier_ref, s.name supplier, b.due_date, b.currency, b.total, b.amount_paid, (b.total - b.amount_paid) outstanding, DATEDIFF(CURDATE(), b.due_date) days_overdue,
       (b.total - b.amount_paid) * b.fx_rate outstanding_base FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id AND s.agency_id = b.agency_id
     WHERE b.agency_id = ? AND b.status IN ('approved','partially_paid') AND b.total - b.amount_paid > 0.005 ORDER BY b.due_date`, [t.agencyId]));
});

// Statement = the party's control-account ledger (base currency) + their open documents
financeRouter.get('/statements/:kind/:id', async (req, res) => {
  const t = T(req), id = idParam(req), kind = req.params.kind === 'supplier' ? 'suppliers' : 'clients';
  if (!['client', 'supplier'].includes(String(req.params.kind))) throw new HttpError(400, 'kind must be client or supplier');
  const party = await t.get(kind, id);
  if (!party) throw new HttpError(404, 'Not found');
  const from = String(req.query.from ?? '2000-01-01'), to = String(req.query.to ?? today());
  if (!party.account_id) return void res.json({ party, opening: 0, closing: 0, rows: [], open: [] });
  const acc = await t.get('accounts', party.account_id);
  const prior = await t.one<{ d: number }>('SELECT COALESCE(SUM(debit - credit),0) d FROM gl_entries WHERE agency_id = ? AND account_id = ? AND entry_date < ?', [t.agencyId, acc.id, from]);
  const sign = kind === 'clients' ? 1 : -1; // receivables: debit-positive; payables shown credit-positive
  const rows = await t.query(`SELECT g.entry_date, g.debit, g.credit, g.narration, v.voucher_no, v.voucher_type FROM gl_entries g JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id
    WHERE g.agency_id = ? AND g.account_id = ? AND g.entry_date BETWEEN ? AND ? ORDER BY g.entry_date, g.id`, [t.agencyId, acc.id, from, to]);
  let bal = r2(sign * (acc.opening_dr - acc.opening_cr + prior!.d)); const opening = bal;
  const out = rows.map((r: any) => ({ ...r, balance: (bal = r2(bal + sign * (r.debit - r.credit))) }));
  const open = kind === 'clients'
    ? await t.query(`SELECT id, number ref, currency, total, amount_credited, amount_paid, (total - amount_credited - amount_paid) outstanding, due_date FROM invoices WHERE agency_id = ? AND client_id = ? AND voucher_id IS NOT NULL AND status NOT IN ('void') AND ABS(total - amount_credited - amount_paid) > 0.005 ORDER BY due_date`, [t.agencyId, id])
    : await t.query(`SELECT id, bill_no ref, currency, total, amount_paid, (total - amount_paid) outstanding, due_date FROM supplier_bills WHERE agency_id = ? AND supplier_id = ? AND status IN ('approved','partially_paid') ORDER BY due_date`, [t.agencyId, id]);
  res.json({ party: { id: party.id, name: party.name }, opening, closing: bal, rows: out, open });
});

financeRouter.get('/clients/:id/open-invoices', async (req, res) => {
  const t = T(req), id = idParam(req); await t.ref('clients', id, 'client');
  res.json(await t.query(`SELECT id, number, currency, total, amount_credited, amount_paid, (total - amount_credited - amount_paid) outstanding, due_date, status FROM invoices
    WHERE agency_id = ? AND client_id = ? AND voucher_id IS NOT NULL AND status NOT IN ('void','draft','reviewed') AND total - amount_credited - amount_paid > 0.005 ORDER BY due_date`, [t.agencyId, id]));
});

// ---------------------------------------------------------------- exchange rates (manual + provider, dated, with source)
financeRouter.get('/rates', async (req, res) => {
  const t = T(req), a = await t.agency();
  const rows = await t.query(`SELECT e.base, e.quote, e.rate, e.rate_date, e.source, DATEDIFF(CURDATE(), e.rate_date) age_days, u.name entered_by
    FROM exchange_rates e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.agency_id = ? AND e.rate_date = (SELECT MAX(x.rate_date) FROM exchange_rates x WHERE x.agency_id = e.agency_id AND x.base = e.base AND x.quote = e.quote) ORDER BY e.base, e.quote`, [t.agencyId]);
  res.json({ base_currency: a.base_currency, max_age_days: a.fx_max_age_days, rates: rows.map((r: any) => ({ ...r, stale: r.age_days > a.fx_max_age_days })) });
});

financeRouter.post('/rates', W, async (req, res) => {
  const b = parse(z.object({ from: z.string().length(3).transform((s) => s.toUpperCase()), to: z.string().length(3).transform((s) => s.toUpperCase()), rate: z.number().positive().max(1e7),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), confirm: z.boolean().optional() }), req.body);
  if (b.from === b.to) throw new HttpError(400, 'Currencies must differ');
  const t = T(req), date = b.date ?? today();
  if (date > today()) throw new HttpError(400, 'Rates cannot be dated in the future');
  // plausibility guard: a typo (1.25 → 12.5) would silently misstate every document that uses the rate
  const prev = await t.one(`SELECT base, rate FROM exchange_rates WHERE agency_id = ? AND ((base = ? AND quote = ?) OR (base = ? AND quote = ?)) ORDER BY rate_date DESC LIMIT 1`, [t.agencyId, b.from, b.to, b.to, b.from]);
  if (prev && !b.confirm) {
    const last = prev.base === b.from ? prev.rate : 1 / prev.rate, change = Math.abs(b.rate / last - 1);
    if (change > 0.25) throw new HttpError(409, `This rate differs from the last known rate (${last.toFixed(6)}) by ${(change * 100).toFixed(0)}%. If it is correct, confirm it.`);
  }
  await t.query(`INSERT INTO exchange_rates (agency_id, rate_date, base, quote, rate, source, created_by) VALUES (?,?,?,?,?, 'manual', ?) ON DUPLICATE KEY UPDATE rate = VALUES(rate), source = 'manual', created_by = VALUES(created_by)`,
    [t.agencyId, date, b.from, b.to, b.rate, req.ctx!.userId]);
  await t.event('create', 'exchange_rates', null, prev ?? null, { from: b.from, to: b.to, rate: b.rate, date, source: 'manual' }, b.confirm ? 'Confirmed large change' : undefined);
  res.status(201).json({ from: b.from, to: b.to, rate: b.rate, date, source: 'manual' });
});

// ---------------------------------------------------------------- receipts
financeRouter.get('/receipts', async (req, res) => {
  const t = T(req), client = Number(req.query.client_id) || null;
  res.json(await t.query(`SELECT r.*, c.name client_name, a.name cash_name FROM receipts r JOIN clients c ON c.id = r.client_id AND c.agency_id = r.agency_id JOIN accounts a ON a.id = r.cash_account_id AND a.agency_id = r.agency_id
    WHERE r.agency_id = ? ${client ? 'AND r.client_id = ?' : ''} ORDER BY r.id DESC LIMIT 300`, client ? [t.agencyId, client] : [t.agencyId]));
});
financeRouter.get('/receipts/:id', async (req, res) => {
  const t = T(req), id = idParam(req), r = await t.get('receipts', id);
  if (!r) throw new HttpError(404, 'Not found');
  res.json({ ...r, allocations: await t.query(`SELECT p.id, p.invoice_id, i.number invoice_number, p.amount, p.voided FROM payments p JOIN invoices i ON i.id = p.invoice_id AND i.agency_id = p.agency_id WHERE p.agency_id = ? AND p.receipt_id = ?`, [t.agencyId, id]) });
});
financeRouter.post('/receipts', W, async (req, res) => {
  const b = parse(z.object({ client_id: z.number().int(), cash_account_id: z.number().int(), amount: z.number().positive(), currency: z.string().length(3).optional(), fx_rate: z.number().positive().optional(),
    receipt_date: z.string().optional(), method: METHOD, reference: z.string().max(100).nullish(), narration: z.string().max(300).nullish(), allocations: z.array(Alloc).default([]) }), req.body);
  const idem = String(req.headers['idempotency-key'] ?? '').slice(0, 80) || null;
  const r = await F.createReceipt(T(req), { ...b, idem_key: idem });
  res.status(r.replay ? 200 : 201).json({ ...r.receipt, replay: r.replay });
});
financeRouter.post('/receipts/:id/allocate', W, async (req, res) => {
  const b = parse(z.object({ allocations: z.array(Alloc).min(1) }), req.body);
  res.json(await F.allocateReceipt(T(req), idParam(req), b.allocations));
});
financeRouter.post('/receipts/:id/void', W, async (req, res) => {
  const b = parse(Reason, req.body); res.json(await F.voidReceipt(T(req), idParam(req), b.reason, b.date ?? today()));
});

// ---------------------------------------------------------------- credit notes
financeRouter.get('/credit-notes', async (req, res) => {
  const t = T(req);
  res.json(await t.query(`SELECT n.*, i.number invoice_number, c.name client_name FROM credit_notes n JOIN invoices i ON i.id = n.invoice_id AND i.agency_id = n.agency_id JOIN clients c ON c.id = n.client_id AND c.agency_id = n.agency_id WHERE n.agency_id = ? ORDER BY n.id DESC LIMIT 300`, [t.agencyId]));
});
financeRouter.get('/credit-notes/:id', async (req, res) => {
  const t = T(req), id = idParam(req), n = await t.get('credit_notes', id);
  if (!n) throw new HttpError(404, 'Not found');
  res.json({ ...n, lines: await t.query('SELECT * FROM credit_note_lines WHERE agency_id = ? AND credit_note_id = ?', [t.agencyId, id]) });
});
financeRouter.post('/credit-notes', W, async (req, res) => {
  const b = parse(z.object({ invoice_id: z.number().int(), reason: z.string().optional().default(''), issue_date: z.string().optional(), lines: z.array(z.object({ description: z.string().min(1), amount: z.number().positive(), tax: z.number().min(0).optional() })).min(1) }), req.body);
  res.status(201).json({ id: await F.createCreditNote(T(req), b) });
});
financeRouter.post('/credit-notes/:id/issue', W, async (req, res) => res.json(await F.issueCreditNote(T(req), idParam(req))));
financeRouter.post('/credit-notes/:id/void', W, async (req, res) => { const b = parse(Reason, req.body); res.json(await F.voidCreditNote(T(req), idParam(req), b.reason, b.date ?? today())); });

// ---------------------------------------------------------------- client refunds
financeRouter.get('/client-refunds', async (req, res) => {
  const t = T(req);
  res.json(await t.query(`SELECT r.*, i.number invoice_number, c.name client_name, u.name requested_by_name FROM client_refunds r JOIN invoices i ON i.id = r.invoice_id AND i.agency_id = r.agency_id JOIN clients c ON c.id = r.client_id AND c.agency_id = r.agency_id LEFT JOIN users u ON u.id = r.requested_by WHERE r.agency_id = ? ORDER BY r.id DESC LIMIT 300`, [t.agencyId]));
});
financeRouter.post('/client-refunds', W, async (req, res) => {
  const b = parse(z.object({ invoice_id: z.number().int(), amount: z.number().positive(), method: METHOD, cash_account_id: z.number().int(), reason: z.string().optional().default('') }), req.body);
  res.status(201).json({ id: await F.requestRefund(T(req), b) });
});
financeRouter.post('/client-refunds/:id/approve', W, async (req, res) => { await F.approveRefund(T(req), idParam(req)); res.json({ status: 'approved' }); });
financeRouter.post('/client-refunds/:id/reject', W, async (req, res) => { await F.rejectRefund(T(req), idParam(req)); res.json({ status: 'rejected' }); });
financeRouter.post('/client-refunds/:id/pay', W, async (req, res) => res.json(await F.payRefund(T(req), idParam(req), parse(z.object({ date: z.string().optional() }), req.body).date)));

// ---------------------------------------------------------------- supplier bills
financeRouter.get('/bills', async (req, res) => {
  const t = T(req), status = String(req.query.status ?? '');
  res.json(await t.query(`SELECT b.*, s.name supplier_name, (b.total - b.amount_paid) outstanding FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id AND s.agency_id = b.agency_id WHERE b.agency_id = ? ${status ? 'AND b.status = ?' : ''} ORDER BY b.id DESC LIMIT 300`, status ? [t.agencyId, status] : [t.agencyId]));
});
financeRouter.get('/bills/:id', async (req, res) => {
  const t = T(req), id = idParam(req), b = await t.get('supplier_bills', id);
  if (!b) throw new HttpError(404, 'Not found');
  res.json({ ...b, lines: await t.query('SELECT * FROM supplier_bill_lines WHERE agency_id = ? AND bill_id = ?', [t.agencyId, id]),
    payments: await t.query('SELECT id, amount, paid_at, reference FROM payments WHERE agency_id = ? AND bill_id = ? AND voided = 0', [t.agencyId, id]) });
});
financeRouter.post('/bills', W, async (req, res) => {
  const b = parse(z.object({ supplier_id: z.number().int(), supplier_ref: z.string().min(1).max(80), bill_date: z.string(), due_date: z.string().optional(), currency: z.string().length(3).optional(), booking_id: z.number().int().nullish(), notes: z.string().max(500).nullish(),
    lines: z.array(z.object({ component_id: z.number().int().nullish(), description: z.string().min(1), amount: z.number().positive(), tax: z.number().min(0).optional() })).min(1) }), req.body);
  res.status(201).json(await F.createBill(T(req), b));
});
financeRouter.post('/bills/:id/approve', W, async (req, res) => res.json(await F.approveBill(T(req), idParam(req), parse(z.object({ override_reason: z.string().optional() }), req.body).override_reason)));
financeRouter.post('/bills/:id/void', W, async (req, res) => { const b = parse(Reason, req.body); res.json(await F.voidBill(T(req), idParam(req), b.reason, b.date ?? today())); });
financeRouter.post('/bills/:id/pay', W, async (req, res) => {
  const b = parse(z.object({ cash_account_id: z.number().int(), amount: z.number().positive(), date: z.string().optional(), reference: z.string().max(100).nullish(), fx_rate: z.number().positive().optional() }), req.body);
  res.json(await F.payBill(T(req), idParam(req), b));
});

// ---------------------------------------------------------------- payment runs (bills → bank file → settlement)
const APPROVERS = requireRole('admin', 'finance_manager');
financeRouter.get('/payment-runs', async (req, res) => res.json(await PR.listRuns(T(req))));
financeRouter.get('/payment-runs/:id', async (req, res) => res.json(await PR.runDetail(T(req), idParam(req))));
financeRouter.post('/payment-runs', W, async (req, res) => {
  const b = parse(z.object({ run_date: z.string().default(() => today()), currency: z.string().length(3), bank_account_id: z.number().int(), notes: z.string().max(300).optional(),
    items: z.array(z.object({ bill_id: z.number().int(), amount: z.number().positive().optional() })).min(1).max(500) }), req.body);
  res.status(201).json({ id: await PR.createRun(T(req), b) });
});
financeRouter.delete('/payment-runs/:id/items/:itemId', W, async (req, res) => res.json(await PR.removeItem(T(req), idParam(req), Number(req.params.itemId))));
financeRouter.post('/payment-runs/:id/validate', W, async (req, res) => { const r = await PR.validateRun(T(req), idParam(req)); res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: 'Validation failed', ...r }); });
financeRouter.post('/payment-runs/:id/submit', W, async (req, res) => { const r = await PR.submitRun(T(req), idParam(req)); res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: 'Validation failed', ...r }); });
financeRouter.post('/payment-runs/:id/approve', APPROVERS, async (req, res) => res.json(await PR.approveRun(T(req), idParam(req))));
financeRouter.post('/payment-runs/:id/return', APPROVERS, async (req, res) => res.json(await PR.returnToDraft(T(req), idParam(req), parse(Reason, req.body).reason)));
financeRouter.post('/payment-runs/:id/cancel', W, async (req, res) => res.json(await PR.cancelRun(T(req), idParam(req), parse(Reason, req.body).reason)));
financeRouter.get('/payment-runs/:id/bank-file', APPROVERS, async (req, res) => {
  const format = parse(z.enum(['aba', 'ach', 'csv']), req.query.format ?? 'csv');
  const f = await PR.exportRun(T(req), idParam(req), format);
  res.setHeader('Content-Type', 'text/plain'); res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`); res.setHeader('X-File-Checksum', f.checksum);
  res.send(f.body);
});
financeRouter.post('/payment-runs/:id/processing', APPROVERS, async (req, res) => res.json(await PR.markProcessing(T(req), idParam(req))));
financeRouter.post('/payment-runs/:id/settle', APPROVERS, async (req, res) => {
  const b = parse(z.object({ results: z.array(z.object({ item_id: z.number().int(), outcome: z.enum(['paid', 'failed']), date: z.string().optional(), settlement_ref: z.string().max(100).optional(),
    manual_reason: z.string().max(300).optional(), failure_reason: z.string().max(300).optional(), fx_rate: z.number().positive().optional() })).min(1) }), req.body);
  res.json(await PR.settleRun(T(req), idParam(req), b.results));
});
financeRouter.post('/payment-runs/:id/remittance', W, async (req, res) => {
  const t = T(req), id = idParam(req);
  const key = await putFile(fileKey(t.agencyId, 'remittance', `run-${id}.pdf`), await htmlToPdf(await PR.remittanceHtml(t, id)), 'application/pdf');
  res.json({ url: await signedUrl(t.agencyId, key, `remittance-run-${id}.pdf`) });
});

// ---------------------------------------------------------------- migration helper (admin)
financeRouter.post('/backfill-ledger', requireRole('admin'), async (req, res) => res.json(await F.backfillLedger(T(req))));
