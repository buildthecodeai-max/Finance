import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { WRITERS, requireRole } from '../auth.js';
import { ensureSys, postVoucher } from '../services/accounting.js';
import * as C from '../services/commissions.js';
import { r2, today } from '../services/money.js';
import { idParam, parse, T, toCsv } from './util.js';
import { findScoped } from './scope.js';

export { recalcBooking } from '../services/commissions.js';
export const commissionsRouter = Router();
const W = requireRole(...WRITERS), FIN = requireRole('admin', 'finance_manager', 'viewer');
const isAgent = (req: any) => req.ctx.role === 'agent';
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const periodOf = (req: any) => { const p = String(req.params.period); if (!PERIOD.test(p)) throw new HttpError(400, 'Period must be YYYY-MM'); return p; };
const jparse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
const withCalc = (r: any) => ({ ...r, calc_json: jparse(r.calc_json) });

// ------------------------------------------------------------------ rules (every change = a new version; history is kept)
const TYPES = ['flight', 'hotel', 'package', 'cruise', 'transfer', 'tour', 'rail', 'car', 'insurance', 'visa', 'fee', 'other'] as const;
const Rule = z.object({
  name: z.string().min(1).max(120), kind: z.enum(['agent', 'supplier']).default('agent'), basis: z.enum(['pct_selling', 'pct_margin', 'fixed']),
  rate: z.number().min(0).max(100).nullish(), fixed_amount: z.number().min(0).nullish(), tiers: z.array(z.object({ from: z.number().min(0), rate: z.number().min(0).max(100) })).max(12).nullish(),
  deduct_overhead: z.boolean().default(false), branch_id: z.number().int().nullish(), product_type: z.enum(TYPES).nullish(), supplier_id: z.number().int().nullish(),
  destination: z.string().max(150).nullish(), agent_id: z.number().int().nullish(), effective_from: z.string().nullish(), effective_to: z.string().nullish(), priority: z.number().int().min(-100).max(100).default(0),
}).superRefine((r, ctx) => {
  if (r.basis === 'fixed' && r.fixed_amount == null) ctx.addIssue({ code: 'custom', message: 'fixed_amount is required for a fixed rule', path: ['fixed_amount'] });
  if (r.basis !== 'fixed' && r.rate == null && !(r.tiers && r.tiers.length)) ctx.addIssue({ code: 'custom', message: 'rate (or tiers) is required', path: ['rate'] });
  if (r.effective_from && r.effective_to && r.effective_from > r.effective_to) ctx.addIssue({ code: 'custom', message: 'effective_from is after effective_to', path: ['effective_to'] });
  if (r.kind === 'supplier' && (r.agent_id || r.deduct_overhead)) ctx.addIssue({ code: 'custom', message: 'supplier rules cannot be scoped to an agent or deduct overhead', path: ['kind'] });
});

async function ruleRefs(t: any, b: any) {
  await t.ref('branches', b.branch_id, 'branch'); await t.ref('suppliers', b.supplier_id, 'supplier'); await t.memberRef(b.agent_id, 'agent');
}
const ruleRow = (b: z.infer<typeof Rule>) => ({ ...b, deduct_overhead: b.deduct_overhead ? 1 : 0, tiers: b.tiers?.length ? JSON.stringify([...b.tiers].sort((x, y) => x.from - y.from)) : null });

commissionsRouter.get('/rules', requireRole('admin', 'finance_manager', 'viewer'), async (req, res) => {
  const t = T(req), all = req.query.all === '1';
  res.json((await t.query(`SELECT r.*, s.name supplier_name, u.name agent_name FROM commission_rules r LEFT JOIN suppliers s ON s.id = r.supplier_id AND s.agency_id = r.agency_id LEFT JOIN users u ON u.id = r.agent_id
    WHERE r.agency_id = ? ${all ? '' : 'AND r.active = 1'} ORDER BY r.kind, r.name, r.version DESC`, [t.agencyId])).map((r: any) => ({ ...r, tiers: jparse(r.tiers) })));
});
commissionsRouter.get('/rules/:key/history', requireRole('admin', 'finance_manager', 'viewer'), async (req, res) => {
  const t = T(req);
  res.json((await t.query('SELECT r.*, u.name created_by_name FROM commission_rules r LEFT JOIN users u ON u.id = r.created_by WHERE r.agency_id = ? AND r.rule_key = ? ORDER BY r.version DESC', [t.agencyId, req.params.key])).map((r: any) => ({ ...r, tiers: jparse(r.tiers) })));
});
commissionsRouter.post('/rules', W, async (req, res) => {
  const b = parse(Rule, req.body), t = T(req); await ruleRefs(t, b);
  res.status(201).json({ id: await t.insert('commission_rules', { ...ruleRow(b), rule_key: crypto.randomUUID(), version: 1, created_by: req.ctx!.userId }) });
});
// "Editing" creates version N+1 and retires N. Earlier calculations keep pointing at the version they used.
commissionsRouter.put('/rules/:id', W, async (req, res) => {
  const t = T(req), id = idParam(req), cur = await t.get('commission_rules', id);
  if (!cur) throw new HttpError(404, 'Rule not found');
  if (!cur.active) throw new HttpError(409, 'Only the current version of a rule can be changed');
  const b = parse(Rule, req.body); await ruleRefs(t, b);
  const nid = await t.tx(async (tx) => {
    await tx.update('commission_rules', id, { active: 0 });
    return tx.insert('commission_rules', { ...ruleRow(b), rule_key: cur.rule_key, version: cur.version + 1, supersedes_id: id, created_by: req.ctx!.userId });
  });
  res.json({ id: nid, version: cur.version + 1 });
});
commissionsRouter.post('/rules/:id/deactivate', W, async (req, res) => {
  const t = T(req), id = idParam(req), cur = await t.get('commission_rules', id);
  if (!cur) throw new HttpError(404, 'Rule not found');
  await t.update('commission_rules', id, { active: 0 }); res.json({ ok: true });
});

// ------------------------------------------------------------------ recalculation
commissionsRouter.post('/recalculate/:bookingId', W, async (req, res) => res.json(await C.recalcBooking(T(req), Number(req.params.bookingId))));
commissionsRouter.post('/refresh', W, async (req, res) => res.json(await C.refreshAll(T(req))));

// ------------------------------------------------------------------ views (agents see only their own)
commissionsRouter.get('/', async (req, res) => {
  const t = T(req), mine = isAgent(req);
  res.json(await t.query(`SELECT c.*, b.reference, b.destination, b.status booking_status, u.name agent_name FROM commissions c JOIN bookings b ON b.id = c.booking_id AND b.agency_id = c.agency_id LEFT JOIN users u ON u.id = c.agent_id
    WHERE c.agency_id = ? ${mine ? 'AND c.agent_id = ?' : ''} ORDER BY c.id DESC LIMIT 500`, mine ? [t.agencyId, req.ctx!.userId] : [t.agencyId]));
});

commissionsRouter.get('/entries', async (req, res) => {
  const t = T(req), { status, period, agent_id } = req.query as Record<string, string>, mine = isAgent(req);
  res.json(await t.query(`SELECT e.id, e.booking_id, e.agent_id, e.status, e.period, e.amount, e.split_pct, e.margin, e.gross_amount, e.flags, e.rule_summary, e.approved_at, e.paid_at, b.reference, b.destination, b.status booking_status, u.name agent_name
    FROM commission_entries e JOIN bookings b ON b.id = e.booking_id AND b.agency_id = e.agency_id LEFT JOIN users u ON u.id = e.agent_id
    WHERE e.agency_id = ? ${mine ? 'AND e.agent_id = ?' : agent_id ? 'AND e.agent_id = ?' : ''} ${status ? 'AND e.status = ?' : ''} ${period ? 'AND e.period = ?' : ''} ORDER BY e.id DESC LIMIT 500`,
    [t.agencyId, ...(mine ? [req.ctx!.userId] : agent_id ? [Number(agent_id)] : []), ...(status ? [status] : []), ...(period ? [period] : [])]));
});
commissionsRouter.get('/entries/:id', async (req, res) => {
  const t = T(req), e = await t.get('commission_entries', idParam(req));
  if (!e || (isAgent(req) && e.agent_id !== req.ctx!.userId)) throw new HttpError(404, 'Not found');
  const adjustments = await t.query(`SELECT * FROM commission_adjustments WHERE agency_id = ? AND entry_id = ? ORDER BY id`, [t.agencyId, e.id]);
  res.json({ ...withCalc(e), adjustments });
});
// A booking's commission picture: entries, splits, supplier commission
commissionsRouter.get('/bookings/:id', async (req, res) => {
  const t = T(req), id = idParam(req);
  const b = isAgent(req) ? await findScoped(t, req, 'bookings', id, { owner: 'agent_id' }) : await t.get('bookings', id);
  if (!b) throw new HttpError(404, 'Not found');
  const mine = isAgent(req);
  res.json({
    summary: await t.one('SELECT * FROM commissions WHERE agency_id = ? AND booking_id = ?', [t.agencyId, id]) ?? null,
    entries: (await t.query(`SELECT e.*, u.name agent_name FROM commission_entries e LEFT JOIN users u ON u.id = e.agent_id WHERE e.agency_id = ? AND e.booking_id = ? ${mine ? 'AND e.agent_id = ?' : ''}`, mine ? [t.agencyId, id, req.ctx!.userId] : [t.agencyId, id])).map(withCalc),
    splits: await t.query('SELECT s.agent_id, s.pct, u.name agent_name FROM commission_splits s LEFT JOIN users u ON u.id = s.agent_id WHERE s.agency_id = ? AND s.booking_id = ?', [t.agencyId, id]),
    supplier: mine ? [] : await t.query('SELECT sc.*, s.name supplier_name FROM supplier_commissions sc JOIN suppliers s ON s.id = sc.supplier_id AND s.agency_id = sc.agency_id WHERE sc.agency_id = ? AND sc.booking_id = ?', [t.agencyId, id]),
  });
});

// Co-brokering / split ownership. Percentages must total exactly 100. Approved entries are unaffected (adjustments handle changes).
commissionsRouter.put('/bookings/:id/splits', W, async (req, res) => {
  const t = T(req), id = idParam(req), b = await t.get('bookings', id);
  if (!b) throw new HttpError(404, 'Booking not found');
  const body = parse(z.object({ splits: z.array(z.object({ agent_id: z.number().int(), pct: z.number().positive().max(100) })).max(10) }), req.body);
  if (body.splits.length) {
    if (new Set(body.splits.map((s) => s.agent_id)).size !== body.splits.length) throw new HttpError(400, 'An agent may appear once');
    if (Math.abs(body.splits.reduce((s, x) => s + x.pct, 0) - 100) > 0.005) throw new HttpError(400, 'Split percentages must total 100');
    for (const s of body.splits) await t.memberRef(s.agent_id, 'agent');
  }
  await t.tx(async (tx) => {
    await tx.query('DELETE FROM commission_splits WHERE agency_id = ? AND booking_id = ?', [t.agencyId, id]);
    for (const s of body.splits) await tx.insert('commission_splits', { booking_id: id, ...s });
    await tx.event('update', 'commission_splits', id, null, body.splits);
  });
  res.json(await C.recalcBooking(t, id));
});

// Manually negotiated amount for one agent on one booking (reason mandatory). After approval use a manual adjustment instead.
commissionsRouter.put('/entries/:id/override', W, async (req, res) => {
  const t = T(req), id = idParam(req), e = await t.get('commission_entries', id);
  if (!e) throw new HttpError(404, 'Not found');
  if (['approved', 'paid'].includes(e.status)) throw new HttpError(409, 'Approved entries are locked — add an adjustment instead');
  const b = parse(z.object({ amount: z.number().min(0).nullable(), reason: z.string().optional() }), req.body);
  await t.update('commission_entries', id, { override_amount: b.amount, override_reason: b.amount === null ? null : b.reason, override_by: b.amount === null ? null : req.ctx!.userId });
  await C.recalcBooking(t, e.booking_id); res.json(withCalc((await t.get('commission_entries', id))!));
});

commissionsRouter.post('/adjustments', W, async (req, res) => {
  const b = parse(z.object({ agent_id: z.number().int(), amount: z.number().refine((n) => n !== 0, 'Amount cannot be zero'), reason: z.string().optional().default(''), entry_id: z.number().int().nullish() }), req.body), t = T(req);
  await t.memberRef(b.agent_id, 'agent'); await t.ref('commission_entries', b.entry_id, 'commission entry');
  res.status(201).json({ id: await t.insert('commission_adjustments', { ...b, entry_id: b.entry_id ?? null, period: today().slice(0, 7), kind: 'manual', created_by: req.ctx!.userId }) });
});

commissionsRouter.get('/ledger', async (req, res) => {
  const t = T(req), mine = isAgent(req);
  res.json(await t.query(`SELECT u.id agent_id, u.name agent, e.period, e.status, COUNT(*) bookings, SUM(e.margin) margin, SUM(e.amount) amount FROM commission_entries e LEFT JOIN users u ON u.id = e.agent_id
    WHERE e.agency_id = ? AND e.status <> 'reversed' ${mine ? 'AND e.agent_id = ?' : ''} GROUP BY u.id, u.name, e.period, e.status ORDER BY e.period DESC, u.name`, mine ? [t.agencyId, req.ctx!.userId] : [t.agencyId]));
});

// ------------------------------------------------------------------ month-end: submit → approve (second person) → pay; reopen with reason
commissionsRouter.get('/periods', async (req, res) => {
  const t = T(req), mine = isAgent(req);
  const rows = await t.query(`SELECT p.period, p.status, p.total_amount, p.approved_at, p.paid_at FROM commission_periods p WHERE p.agency_id = ? ORDER BY p.period DESC LIMIT 36`, [t.agencyId]);
  const open = await t.query(`SELECT e.period, COUNT(*) n, SUM(e.amount) total FROM commission_entries e WHERE e.agency_id = ? AND e.status = 'eligible' AND e.period IS NOT NULL ${mine ? 'AND e.agent_id = ?' : ''} GROUP BY e.period`, mine ? [t.agencyId, req.ctx!.userId] : [t.agencyId]);
  const known = new Set(rows.map((r: any) => r.period)); const merged = [...rows, ...open.filter((o: any) => !known.has(o.period)).map((o: any) => ({ period: o.period, status: 'open', total_amount: o.total }))];
  res.json(merged.sort((a: any, b: any) => b.period.localeCompare(a.period)));
});
commissionsRouter.get('/periods/:period', async (req, res) => res.json(await C.periodView(T(req), periodOf(req), isAgent(req) ? req.ctx!.userId : undefined)));
commissionsRouter.post('/periods/:period/submit', W, async (req, res) => res.json(await C.submitPeriod(T(req), periodOf(req))));
commissionsRouter.post('/periods/:period/approve', W, async (req, res) => res.json(await C.approvePeriod(T(req), periodOf(req), parse(z.object({ override_reason: z.string().optional() }), req.body).override_reason)));
commissionsRouter.post('/periods/:period/reopen', requireRole('admin'), async (req, res) => res.json(await C.reopenPeriod(T(req), periodOf(req), parse(z.object({ reason: z.string().optional().default('') }), req.body).reason)));
commissionsRouter.post('/periods/:period/pay', W, async (req, res) => res.json(await C.payPeriod(T(req), periodOf(req), parse(z.object({ cash_account_id: z.number().int(), date: z.string().optional() }), req.body))));

// Agent statement for a period (with the rule that produced each figure)
commissionsRouter.get('/periods/:period/statement/:agentId', async (req, res) => {
  const t = T(req), period = periodOf(req), agentId = Number(req.params.agentId);
  if (isAgent(req) && agentId !== req.ctx!.userId) throw new HttpError(404, 'Not found');
  await t.memberRef(agentId, 'agent');
  const v = await C.periodView(t, period, agentId);
  res.json({ period, status: v.status, agent: v.agents[0] ?? { agent_id: agentId, commission: 0, adjustments: 0, net: 0 },
    entries: v.entries.map((e: any) => ({ id: e.id, reference: e.reference, destination: e.destination, status: e.status, margin: e.margin, split_pct: e.split_pct, amount: e.amount, rule: e.rule_summary, flags: e.flags })), adjustments: v.adjustments });
});

// Payroll-ready export: only approved/paid periods, positive nets only
commissionsRouter.get('/periods/:period/payroll.csv', W, async (req, res) => {
  const t = T(req), period = periodOf(req), v = await C.periodView(t, period);
  if (!['approved', 'paid'].includes(v.status)) throw new HttpError(409, 'Approve the period before exporting payroll');
  const rows = await t.query(`SELECT u.id, u.name, u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.agency_id = ? AND u.id IN (?)`, [t.agencyId, v.agents.length ? v.agents.map((a) => a.agent_id) : [0]]);
  const by = new Map(rows.map((r: any) => [r.id, r]));
  res.type('text/csv').attachment(`commission-payroll-${period}.csv`).send(toCsv(['Agent', 'Email', 'Period', 'Bookings', 'Commission', 'Adjustments', 'Net payable'],
    v.agents.filter((a) => a.net > 0).map((a) => [by.get(a.agent_id)?.name ?? a.agent_name, by.get(a.agent_id)?.email ?? '', period, a.entries, a.commission, a.adjustments, a.net])));
});

// ------------------------------------------------------------------ commission the agency expects from suppliers
commissionsRouter.get('/supplier', FIN, async (req, res) => {
  const t = T(req);
  res.json(await t.query(`SELECT sc.*, s.name supplier_name, b.reference, b.destination FROM supplier_commissions sc JOIN suppliers s ON s.id = sc.supplier_id AND s.agency_id = sc.agency_id
    JOIN bookings b ON b.id = sc.booking_id AND b.agency_id = sc.agency_id WHERE sc.agency_id = ? ORDER BY sc.status = 'expected' DESC, sc.id DESC LIMIT 500`, [t.agencyId]));
});
commissionsRouter.post('/supplier/:id/receive', W, async (req, res) => {
  const t = T(req), id = idParam(req), b = parse(z.object({ cash_account_id: z.number().int(), date: z.string().optional() }), req.body);
  const cash = await t.get('accounts', b.cash_account_id);
  if (!cash || cash.type_code !== 110) { await t.ref('accounts', b.cash_account_id, 'cash account'); throw new HttpError(400, 'Deposit to a cash/bank account'); }
  const out = await t.tx(async (tx) => {
    const sc = (await tx.query('SELECT * FROM supplier_commissions WHERE agency_id = ? AND id = ? FOR UPDATE', [tx.agencyId, id]))[0];
    if (!sc) throw new HttpError(404, 'Not found');
    if (sc.status !== 'expected') throw new HttpError(409, `Commission is ${sc.status}`);
    const date = b.date ?? today();
    const vid = await postVoucher(tx, { type: 'receipt', date, narration: `Supplier commission received (booking #${sc.booking_id})`, ref_table: 'supplier_commissions', ref_id: id,
      legs: [{ account_id: b.cash_account_id, debit: sc.amount }, { account_id: await ensureSys(tx, 'commission_income'), credit: sc.amount }] });
    await tx.update('supplier_commissions', id, { status: 'received', received_date: date, voucher_id: vid });
    return { voucher_id: vid, amount: r2(sc.amount) };
  });
  res.json(out);
});
