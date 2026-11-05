import { assertWithinLimit } from '../services/billing.js';
import { archive, changeMember, deleteParty, dependents, memberWorkload, removeMember, restore } from '../services/records.js';
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { ALL_EDITORS, HttpError, WRITERS, requireRole } from '../auth.js';
import { decrypt, encrypt } from '../crypto.js';
import { idParam, parse, T } from './util.js';

export const clientsRouter = Router();
export const suppliersRouter = Router();
export const teamRouter = Router();

const Client = z.object({
  name: z.string().min(1), email: z.string().email().nullish(), phone: z.string().nullish(), address: z.string().nullish(),
  currency: z.string().length(3).default('USD'), payment_terms_days: z.number().int().min(0).default(14),
  billing_preference: z.enum(['email', 'post', 'portal']).default('email'), notes: z.string().nullish(),
});

/** ?status=active (default) | archived | all */
const archFilter = (q: any, a: string) => (q.status === 'archived' ? `AND ${a}.archived_at IS NOT NULL` : q.status === 'all' ? '' : `AND ${a}.archived_at IS NULL`);
clientsRouter.get('/', async (req, res) => {
  const t = T(req);
  res.json(await t.query(
    `SELECT c.*, COALESCE(SUM(i.total - i.amount_credited - i.amount_paid),0) outstanding
     FROM clients c LEFT JOIN invoices i ON i.client_id = c.id AND i.agency_id = c.agency_id AND i.status NOT IN ('draft','void','paid')
     WHERE c.agency_id = ? ${archFilter(req.query, 'c')} GROUP BY c.id ORDER BY c.name`, [t.agencyId]));
});
clientsRouter.get('/:id', async (req, res) => {
  const t = T(req), id = idParam(req);
  const c = await t.get('clients', id);
  if (!c) throw new HttpError(404, 'Not found');
  const invoices = await t.query('SELECT id, number, status, issue_date, due_date, total, amount_paid, amount_credited, currency FROM invoices WHERE agency_id = ? AND client_id = ? ORDER BY id DESC', [t.agencyId, id]);
  const payments = await t.query('SELECT * FROM payments WHERE agency_id = ? AND client_id = ? ORDER BY paid_at DESC', [t.agencyId, id]);
  res.json({ ...c, invoices, payments });
});
clientsRouter.post('/', requireRole(...ALL_EDITORS), async (req, res) => {
  res.status(201).json({ id: await T(req).insert('clients', parse(Client, req.body)) });
});
clientsRouter.put('/:id', requireRole(...ALL_EDITORS), async (req, res) => {
  const t = T(req), id = idParam(req); if (!(await t.get('clients', id))) throw new HttpError(404, 'Not found');
  await t.update('clients', id, parse(Client.partial(), req.body)); res.json({ ok: true });
});
clientsRouter.get('/:id/usage', async (req, res) => { const t = T(req), id = idParam(req); if (!(await t.get('clients', id))) throw new HttpError(404, 'Not found'); const deps = await dependents(t, 'client_id', id, ['portal_links', 'support_requests']); res.json({ can_delete: deps.length === 0, deps }); });
clientsRouter.post('/:id/archive', requireRole(...WRITERS), async (req, res) => { await archive(T(req), 'clients', idParam(req)); res.json({ ok: true }); });
clientsRouter.post('/:id/restore', requireRole(...WRITERS), async (req, res) => { await restore(T(req), 'clients', idParam(req)); res.json({ ok: true }); });
clientsRouter.delete('/:id', requireRole(...WRITERS), async (req, res) => { await deleteParty(T(req), 'clients', idParam(req)); res.json({ ok: true }); });

const BankDetails = z.object({
  account_name: z.string(), bsb: z.string().optional(), routing: z.string().optional(),
  sort_code: z.string().optional(), account_number: z.string(), bank_name: z.string().optional(),
}).partial({ account_name: true });

const Supplier = z.object({
  name: z.string().min(1), email: z.string().email().nullish(),
  supplier_type: z.enum(['airline', 'hotel', 'cruise', 'transfer', 'tour_operator', 'other']).default('other'),
  currency: z.string().length(3).default('USD'), payment_terms_days: z.number().int().default(30),
  commission_override_pct: z.number().min(0).max(100).nullish(), bank_details: BankDetails.optional(),
});

const stripBank = (s: any) => { const { bank_details_enc, ...rest } = s; return { ...rest, has_bank_details: !!bank_details_enc }; };

// Bank details are never returned to the client; only a flag + last 4 digits of the account.
suppliersRouter.get('/', requireRole('admin', 'finance_manager', 'agent', 'viewer'), async (req, res) => {
  res.json((await T(req).query(`SELECT * FROM suppliers s WHERE s.agency_id = ? ${archFilter(req.query, 's')} ORDER BY s.name`, [T(req).agencyId])).map(stripBank));
});
suppliersRouter.get('/:id', async (req, res) => {
  const t = T(req), id = idParam(req);
  const s = await t.get('suppliers', id);
  if (!s) throw new HttpError(404, 'Not found');
  const payments = await t.query('SELECT * FROM payments WHERE agency_id = ? AND supplier_id = ? ORDER BY paid_at DESC', [t.agencyId, id]);
  const lines = await t.query(
    `SELECT i.number, i.issue_date, l.description, l.unit_cost * l.quantity AS cost FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id AND i.agency_id = l.agency_id
     WHERE l.agency_id = ? AND l.supplier_id = ? ORDER BY i.issue_date DESC`, [t.agencyId, id]);
  let last4: string | null = null;
  if (s.bank_details_enc && ['admin', 'finance_manager'].includes(req.ctx!.role)) {
    const bd = JSON.parse(decrypt(s.bank_details_enc)); last4 = String(bd.account_number).slice(-4);
  }
  res.json({ ...stripBank(s), account_last4: last4, payments, purchases: lines });
});
suppliersRouter.post('/', requireRole(...WRITERS), async (req, res) => {
  const { bank_details, ...rest } = parse(Supplier, req.body);
  res.status(201).json({ id: await T(req).insert('suppliers', { ...rest, bank_details_enc: bank_details ? encrypt(JSON.stringify(bank_details)) : null }) });
});
suppliersRouter.put('/:id', requireRole(...WRITERS), async (req, res) => {
  const { bank_details, ...rest } = parse(Supplier.partial(), req.body);
  const data: Record<string, any> = { ...rest };
  if (bank_details) data.bank_details_enc = encrypt(JSON.stringify(bank_details));
  const t = T(req), id = idParam(req); if (!(await t.get('suppliers', id))) throw new HttpError(404, 'Not found');
  await t.update('suppliers', id, data); res.json({ ok: true });
});
suppliersRouter.get('/:id/usage', async (req, res) => { const t = T(req), id = idParam(req); if (!(await t.get('suppliers', id))) throw new HttpError(404, 'Not found'); const deps = await dependents(t, 'supplier_id', id); res.json({ can_delete: deps.length === 0, deps }); });
suppliersRouter.post('/:id/archive', requireRole(...WRITERS), async (req, res) => { await archive(T(req), 'suppliers', idParam(req)); res.json({ ok: true }); });
suppliersRouter.post('/:id/restore', requireRole(...WRITERS), async (req, res) => { await restore(T(req), 'suppliers', idParam(req)); res.json({ ok: true }); });
suppliersRouter.delete('/:id', requireRole(...WRITERS), async (req, res) => { await deleteParty(T(req), 'suppliers', idParam(req)); res.json({ ok: true }); });

// Team: roles are per agency (the same user can be Admin in one agency and Viewer in another).
teamRouter.get('/', requireRole('admin', 'finance_manager'), async (req, res) => {
  res.json(await T(req).query(
    `SELECT m.id, m.user_id, m.role, m.default_commission_pct, m.branch_id, b.name branch_name, u.name, u.email, u.totp_enabled FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN branches b ON b.id = m.branch_id AND b.agency_id = m.agency_id WHERE m.agency_id = ? ORDER BY FIELD(m.role,'admin','finance_manager','agent','viewer'), u.name`, [T(req).agencyId]));
});
teamRouter.get('/agents', async (req, res) => {
  res.json(await T(req).query(`SELECT m.user_id id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.agency_id = ? AND m.role IN ('agent','finance_manager','admin')`, [T(req).agencyId]));
});
teamRouter.post('/', requireRole('admin'), async (req, res) => {
  const b = parse(z.object({
    email: z.string().email(), name: z.string().min(1), role: z.enum(['admin', 'finance_manager', 'agent', 'viewer']),
    password: z.string().min(10).optional(), default_commission_pct: z.number().min(0).max(100).default(0), branch_id: z.number().int().nullish(),
  }), req.body);
  await T(req).ref('branches', b.branch_id, 'branch');
  await assertWithinLimit(req.ctx!.agencyId, 'seats');
  const [ex]: any = await pool.query('SELECT id FROM users WHERE email = ?', [b.email]);
  let userId = ex[0]?.id;
  if (!userId) {
    if (!b.password) throw new HttpError(400, 'password required for new users');
    const [u]: any = await pool.query('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)', [b.email, b.name, await bcrypt.hash(b.password, 12)]);
    userId = u.insertId;
  }
  res.status(201).json({ id: await T(req).insert('memberships', { user_id: userId, role: b.role, default_commission_pct: b.default_commission_pct, branch_id: b.branch_id ?? null }) });
});
teamRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const b = parse(z.object({ role: z.enum(['admin', 'finance_manager', 'agent', 'viewer']).optional(), default_commission_pct: z.number().min(0).max(100).optional(), branch_id: z.number().int().nullish() }), req.body);
  await changeMember(T(req), idParam(req), b, req.ctx!.userId); res.json({ ok: true });
});
teamRouter.get('/:id/workload', requireRole('admin'), async (req, res) => { const t = T(req), m = await t.get('memberships', idParam(req)); if (!m) throw new HttpError(404, 'Team member not found'); res.json(await memberWorkload(t, m.user_id)); });
teamRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const b = parse(z.object({ reassign_to: z.number().int().nullish() }), req.body ?? {});
  res.json({ ok: true, ...(await removeMember(T(req), idParam(req), req.ctx!.userId, b.reassign_to)) });
});
