import { assertWithinLimit } from '../services/billing.js';
import { dependents, deleteBranch, renameBranch } from '../services/records.js';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, WRITERS, requireRole } from '../auth.js';
import { BALANCE_SQL, createAccount, nextAccountCode, postVoucher } from '../services/accounting.js';
import { r2, today } from '../services/money.js';
import { idParam, parse, T } from './util.js';

export const accountingRouter = Router();
const READERS = requireRole('admin', 'finance_manager', 'viewer');

// Lightweight dropdown lookup — available to every role (agents need client/vendor codes on ticket forms).
accountingRouter.get('/lookup', async (req, res) => {
  const t = T(req);
  const types = String(req.query.types ?? '').split(',').map(Number).filter(Boolean);
  res.json(await t.query(
    `SELECT id, code, name, type_code FROM accounts WHERE agency_id = ? ${types.length ? 'AND type_code IN (?)' : ''} ORDER BY name`,
    types.length ? [t.agencyId, types] : [t.agencyId]));
});
accountingRouter.get('/branches', async (req, res) => res.json(await T(req).query('SELECT id, name FROM branches WHERE agency_id = ? ORDER BY name', [T(req).agencyId])));
accountingRouter.get('/departments', async (req, res) => res.json(await T(req).query('SELECT id, name FROM departments WHERE agency_id = ? ORDER BY name', [T(req).agencyId])));
accountingRouter.post('/branches', requireRole(...WRITERS), async (req, res) => {
  await assertWithinLimit(req.ctx!.agencyId, 'branches');
  res.status(201).json({ id: await T(req).insert('branches', parse(z.object({ name: z.string().min(1) }), req.body)) });
});
accountingRouter.put('/branches/:id', requireRole(...WRITERS), async (req, res) => { await renameBranch(T(req), idParam(req), parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body).name); res.json({ ok: true }); });
accountingRouter.get('/branches/:id/usage', async (req, res) => { const deps = await dependents(T(req), 'branch_id', idParam(req)); res.json({ can_delete: deps.length === 0, deps }); });
accountingRouter.delete('/branches/:id', requireRole(...WRITERS), async (req, res) => { await deleteBranch(T(req), idParam(req)); res.json({ ok: true }); });
accountingRouter.post('/departments', requireRole(...WRITERS), async (req, res) => {
  res.status(201).json({ id: await T(req).insert('departments', parse(z.object({ name: z.string().min(1) }), req.body)) });
});

accountingRouter.get('/types', READERS, async (req, res) => {
  const t = T(req);
  res.json(await t.query(
    `SELECT at.code, at.name, at.nature, (SELECT COUNT(*) FROM accounts a WHERE a.agency_id = ? AND a.type_code = at.code) n FROM account_types at ORDER BY at.code`, [t.agencyId]));
});

const Account = z.object({
  type_code: z.number().int(), name: z.string().min(1), branch_id: z.number().int().nullish(), city: z.string().nullish(),
  currency: z.string().length(3).nullish(), opening_dr: z.number().min(0).default(0), opening_cr: z.number().min(0).default(0),
  opening_date: z.string().nullish(), details: z.string().nullish(),
});

accountingRouter.get('/accounts', READERS, async (req, res) => {
  const t = T(req), type = Number(req.query.type) || null, q = req.query.q ? `%${req.query.q}%` : null;
  res.json(await t.query(
    `SELECT a.*, b.name branch, u.name created_by_name, ${BALANCE_SQL} balance
     FROM accounts a LEFT JOIN branches b ON b.id = a.branch_id AND b.agency_id = a.agency_id LEFT JOIN users u ON u.id = a.created_by
     WHERE a.agency_id = ? ${type ? 'AND a.type_code = ?' : ''} ${q ? 'AND (a.name LIKE ? OR a.code LIKE ?)' : ''} ORDER BY a.code`,
    [t.agencyId, ...(type ? [type] : []), ...(q ? [q, q] : [])]));
});

accountingRouter.post('/accounts', requireRole(...WRITERS), async (req, res) => {
  const b = parse(Account, req.body);
  const t = T(req);
  await t.ref('branches', b.branch_id, 'branch');
  res.status(201).json({ id: await createAccount(t, b) });
});

accountingRouter.put('/accounts/:id', requireRole(...WRITERS), async (req, res) => {
  const { type_code, ...rest } = parse(Account.partial(), req.body); void type_code;
  await T(req).ref('branches', rest.branch_id, 'branch');
  await T(req).update('accounts', idParam(req), rest); res.json({ ok: true });
});

// "Transfer Account": move an account to a different account type (re-issues its code in the new range).
accountingRouter.post('/accounts/:id/transfer', requireRole(...WRITERS), async (req, res) => {
  const { type_code } = parse(z.object({ type_code: z.number().int() }), req.body);
  const t = T(req), id = idParam(req);
  const acc = await t.get('accounts', id);
  if (!acc) throw new HttpError(404, 'Not found');
  if (acc.sys_key) throw new HttpError(409, 'System accounts cannot be transferred');
  await t.update('accounts', id, { type_code, code: await nextAccountCode(t, type_code) });
  res.json({ ok: true });
});

accountingRouter.delete('/accounts/:id', requireRole(...WRITERS), async (req, res) => {
  const t = T(req), id = idParam(req);
  const acc = await t.get('accounts', id);
  if (!acc) throw new HttpError(404, 'Not found');
  if (acc.sys_key) throw new HttpError(409, 'System accounts cannot be deleted');
  if (await t.one('SELECT id FROM gl_entries WHERE agency_id = ? AND account_id = ? LIMIT 1', [t.agencyId, id]))
    throw new HttpError(409, 'Account has transactions');
  await t.remove('accounts', id); res.json({ ok: true });
});

// Ledger: opening + running balance for one account
accountingRouter.get('/ledger', READERS, async (req, res) => {
  const t = T(req);
  const id = Number(req.query.account_id);
  const acc = await t.get('accounts', id);
  if (!acc) throw new HttpError(404, 'Account not found');
  const from = String(req.query.from ?? `${new Date().getUTCFullYear()}-01-01`), to = String(req.query.to ?? today());
  const prior = await t.one<{ d: number }>(
    'SELECT COALESCE(SUM(debit - credit),0) d FROM gl_entries WHERE agency_id = ? AND account_id = ? AND entry_date < ?', [t.agencyId, id, from]);
  const opening = r2(acc.opening_dr - acc.opening_cr + prior!.d);
  const rows = await t.query(
    `SELECT g.entry_date, g.debit, g.credit, g.narration, v.voucher_type, v.voucher_no FROM gl_entries g JOIN vouchers v ON v.id = g.voucher_id AND v.agency_id = g.agency_id
     WHERE g.agency_id = ? AND g.account_id = ? AND g.entry_date BETWEEN ? AND ? ORDER BY g.entry_date, g.id`, [t.agencyId, id, from, to]);
  let bal = opening;
  const lines = rows.map((r: any) => ({ ...r, balance: (bal = r2(bal + r.debit - r.credit)) }));
  res.json({ account: acc, from, to, opening, closing: bal, rows: lines });
});

accountingRouter.get('/cash-bank', READERS, async (req, res) => {
  const t = T(req);
  res.json(await t.query(`SELECT a.id, a.code, a.name, ${BALANCE_SQL} balance FROM accounts a WHERE a.agency_id = ? AND a.type_code = 110 ORDER BY a.code`, [t.agencyId]));
});

accountingRouter.get('/trial-balance', READERS, async (req, res) => {
  const t = T(req);
  const rows = await t.query(
    `SELECT a.code, a.name, at.name type, ${BALANCE_SQL} bal FROM accounts a JOIN account_types at ON at.code = a.type_code WHERE a.agency_id = ? ORDER BY a.code`, [t.agencyId]);
  const out = rows.filter((r: any) => Math.abs(r.bal) > 0.004).map((r: any) => ({ ...r, debit: r.bal > 0 ? r.bal : 0, credit: r.bal < 0 ? -r.bal : 0 }));
  res.json({ rows: out, debit: r2(out.reduce((s: number, r: any) => s + r.debit, 0)), credit: r2(out.reduce((s: number, r: any) => s + r.credit, 0)) });
});

// ---- Journal vouchers ----
accountingRouter.get('/journal', READERS, async (req, res) => {
  const t = T(req);
  res.json(await t.query(
    `SELECT v.id, v.voucher_no, v.voucher_date, v.narration, (SELECT SUM(debit) FROM gl_entries g WHERE g.agency_id = v.agency_id AND g.voucher_id = v.id) amount
     FROM vouchers v WHERE v.agency_id = ? AND v.voucher_type = 'journal' ORDER BY v.id DESC LIMIT 300`, [t.agencyId]));
});
accountingRouter.get('/journal/:id', READERS, async (req, res) => {
  const t = T(req), id = idParam(req);
  const v = await t.get('vouchers', id);
  if (!v) throw new HttpError(404, 'Not found');
  res.json({ ...v, lines: await t.query(`SELECT g.*, a.code, a.name FROM gl_entries g JOIN accounts a ON a.id = g.account_id WHERE g.agency_id = ? AND g.voucher_id = ?`, [t.agencyId, id]) });
});
accountingRouter.post('/journal', requireRole(...WRITERS), async (req, res) => {
  const b = parse(z.object({
    date: z.string().default(() => today()), narration: z.string().optional(),
    lines: z.array(z.object({ account_id: z.number().int(), debit: z.number().min(0).default(0), credit: z.number().min(0).default(0), narration: z.string().optional() })).min(2),
  }), req.body);
  const id = await T(req).tx((tx) => postVoucher(tx, { type: 'journal', date: b.date, narration: b.narration, legs: b.lines }));
  res.status(201).json({ id });
});
