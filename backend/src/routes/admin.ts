import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { requireRole } from '../auth.js';
import { idParam, parse, T } from './util.js';
import { pool } from '../db.js';
import { fileKey, putFile, signedUrl } from '../storage.js';
import { DEFAULT_TEMPLATE, TEMPLATES, TEMPLATE_KEYS, isTemplateKey } from '../services/invoiceTemplates.js';
import { sampleInvoiceHtml } from '../services/invoicePreview.js';
import { agencyLogoData } from '../services/vouchers.js';

export const adminRouter = Router();
const FINANCE = requireRole('admin', 'finance_manager');

// ---- Agency settings ----
const publicSettings = (a: any) => ({ id: a.id, name: a.name, base_currency: a.base_currency, tax_label: a.tax_label, address: a.address, timezone: a.timezone, invoice_prefix: a.invoice_prefix, min_margin_pct: a.min_margin_pct, approval_threshold: a.approval_threshold, dual_control_runs: !!a.dual_control_runs, bill_tolerance_pct: a.bill_tolerance_pct, fx_max_age_days: a.fx_max_age_days, commission_trigger: a.commission_trigger, locked_through: a.locked_through,
  tax_number: a.tax_number, bank_name: a.bank_name, bank_account_name: a.bank_account_name, bank_account_number: a.bank_account_number, bank_routing: a.bank_routing,
  bank_iban: a.bank_iban, bank_swift: a.bank_swift, payment_instructions: a.payment_instructions, has_logo: !!a.logo_key, invoice_template: isTemplateKey(a.invoice_template) ? a.invoice_template : DEFAULT_TEMPLATE });

adminRouter.get('/settings', async (req, res) => res.json(publicSettings(await T(req).agency())));

adminRouter.put('/settings', requireRole('admin'), async (req, res) => {
  const b = parse(z.object({
    name: z.string().min(2).optional(), tax_label: z.string().min(1).max(10).optional(), address: z.string().nullish(),
    timezone: z.string().min(1).max(50).refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone').optional(),
    invoice_prefix: z.string().max(10).optional(), min_margin_pct: z.number().min(0).max(100).optional(), approval_threshold: z.number().min(0).optional(), dual_control_runs: z.boolean().optional(), bill_tolerance_pct: z.number().min(0).max(100).optional(), fx_max_age_days: z.number().int().min(0).max(365).optional(), commission_trigger: z.enum(['booking_confirmed', 'client_paid', 'travel_completed', 'supplier_paid']).optional(),
    tax_number: z.string().max(40).nullish(), bank_name: z.string().max(100).nullish(), bank_account_name: z.string().max(150).nullish(), bank_account_number: z.string().max(40).nullish(),
    bank_routing: z.string().max(30).nullish(), bank_iban: z.string().max(40).nullish(), bank_swift: z.string().max(15).nullish(), payment_instructions: z.string().max(500).nullish(), invoice_template: z.enum(TEMPLATE_KEYS).optional(), base_currency: z.string().length(3).optional(), reason: z.string().min(3).optional(),
  }), req.body);
  const t = T(req); const before = await t.agency();
  const { reason, ...fields } = b;
  for (const k of Object.keys(fields) as (keyof typeof fields)[]) if (typeof fields[k] === 'string' && !(fields[k] as string).trim() && k !== 'name') (fields as any)[k] = null;
  if (fields.base_currency && fields.base_currency !== before.base_currency) {
    // Changing base currency after postings would silently rewrite history; refuse.
    const used = await t.one('SELECT (SELECT COUNT(*) FROM gl_entries WHERE agency_id = ?) + (SELECT COUNT(*) FROM invoices WHERE agency_id = ?) n', [t.agencyId, t.agencyId]);
    if (used!.n > 0) throw new HttpError(409, 'Base currency cannot change once transactions exist');
  }
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (keys.length) {
    await t.updateAgency(fields);
    await t.event('update', 'agencies', t.agencyId, publicSettings(before), fields, reason);
  }
  res.json(publicSettings(await t.agency()));
});

// ---- Invoice designs: the agency picks one default for every client-facing invoice (PUT /settings { invoice_template }) ----
adminRouter.get('/invoice-templates', async (req, res) => {
  const a = await T(req).agency();
  res.json({ selected: isTemplateKey(a.invoice_template) ? a.invoice_template : DEFAULT_TEMPLATE, templates: TEMPLATES.map(({ key, name, about }) => ({ key, name, about })) });
});

/** One design drawn with a made-up booking and the agency's own letterhead, logo and bank details. ?doc=ticket shows the ticket invoice instead. */
adminRouter.get('/invoice-templates/:key/preview', async (req, res) => {
  const key = req.params.key;
  if (!isTemplateKey(key)) throw new HttpError(404, 'Unknown invoice design');
  const agency = await T(req).agency();
  res.json({ html: sampleInvoiceHtml(agency, await agencyLogoData(agency), key, req.query.doc === 'ticket' ? 'ticket' : 'invoice') });
});

// ---- Agency logo upload / delete ----
adminRouter.get('/logo', requireRole('admin'), async (req, res) => {
  const t = T(req); const a = await t.agency();
  if (!a.logo_key) return void res.json({ url: null });
  res.json({ url: await signedUrl(t.agencyId, a.logo_key) });
});

adminRouter.post('/logo', requireRole('admin'), async (req, res) => {
  const b = parse(z.object({ data: z.string().min(1), mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']) }), req.body);
  const buf = Buffer.from(b.data, 'base64');
  if (buf.length > 2 * 1024 * 1024) throw new HttpError(413, 'Logo must be under 2 MB');
  const ext = b.mime.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const t = T(req);
  const key = await putFile(fileKey(t.agencyId, 'logos', `logo.${ext}`), buf, b.mime);
  await t.updateAgency({ logo_key: key });
  res.json({ url: await signedUrl(t.agencyId, key) });
});

adminRouter.delete('/logo', requireRole('admin'), async (req, res) => {
  const t = T(req); await t.updateAgency({ logo_key: null }); res.json({ ok: true });
});

// ---- Accounting period lock / reopen (reason always required, history append-only) ----
adminRouter.get('/period-locks', FINANCE, async (req, res) => {
  const t = T(req);
  res.json(await t.query(`SELECT p.*, u.name user_name FROM period_locks p JOIN users u ON u.id = p.user_id WHERE p.agency_id = ? ORDER BY p.id DESC LIMIT 100`, [t.agencyId]));
});

adminRouter.post('/period-locks', FINANCE, async (req, res) => {
  const b = parse(z.object({ locked_through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), reason: z.string().optional().default('') }), req.body);
  const t = T(req); const a = await t.agency();
  const prev = a.locked_through ?? null;
  const reopening = prev !== null && (b.locked_through === null || b.locked_through < prev);
  if (b.locked_through !== null && prev !== null && b.locked_through === prev) throw new HttpError(409, 'Period is already locked through that date');
  if (reopening && req.ctx!.role !== 'admin') throw new HttpError(403, 'Only an Admin can reopen a locked period');
  await t.tx(async (tx) => {
    await tx.updateAgency({ locked_through: b.locked_through });
    await tx.insert('period_locks', { action: reopening ? 'reopen' : 'lock', locked_through: b.locked_through, previous_locked_through: prev, reason: b.reason, user_id: req.ctx!.userId });
    await tx.event('update', 'agencies.locked_through', t.agencyId, { locked_through: prev }, { locked_through: b.locked_through }, b.reason);
  });
  res.json({ locked_through: b.locked_through });
});

// ---- Audit viewer (append-only source) ----
adminRouter.get('/audit', FINANCE, async (req, res) => {
  const t = T(req); const { entity, user_id, from, to } = req.query as Record<string, string>;
  const limit = Math.min(Number(req.query.limit) || 100, 500), offset = Math.max(Number(req.query.offset) || 0, 0);
  const where = ['a.agency_id = ?']; const p: any[] = [t.agencyId];
  if (entity) { where.push('a.entity = ?'); p.push(entity); }
  if (user_id) { where.push('a.user_id = ?'); p.push(Number(user_id)); }
  if (from) { where.push('a.created_at >= ?'); p.push(from); }
  if (to) { where.push('a.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); p.push(to); }
  res.json(await t.query(
    `SELECT a.id, a.created_at, a.action, a.entity, a.entity_id, a.reason, a.ip, u.name user_name, a.before_json, a.after_json
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...p, limit, offset]));
});

// Customers can see, and end, operator support access to their own workspace.
adminRouter.get('/support-access', requireRole('admin'), async (req, res) => {
  const t = T(req); res.json(await t.query(`SELECT ss.id, ss.reason, ss.expires_at, ss.revoked_at, ss.created_at, u.email operator FROM support_sessions ss JOIN users u ON u.id = ss.admin_user_id WHERE ss.agency_id = ? ORDER BY ss.id DESC LIMIT 50`, [t.agencyId]));
});
adminRouter.post('/support-access/:id/revoke', requireRole('admin'), async (req, res) => {
  const t = T(req), id = idParam(req), r: any = (await pool.query('UPDATE support_sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()), revoked_by = ? WHERE id = ? AND agency_id = ?', [req.ctx!.userId, id, t.agencyId]))[0];
  if (!r.affectedRows) throw new HttpError(404, 'Session not found');
  await pool.query('INSERT INTO security_events (agency_id, user_id, ip, event, detail) VALUES (?,?,?,?,?)', [t.agencyId, req.ctx!.userId, req.ip, 'support_access_revoked', `session ${id}`]);
  res.json({ ok: true });
});

adminRouter.get('/security-events', FINANCE, async (req, res) => {
  const t = T(req);
  res.json(await t.query(`SELECT s.id, s.created_at, s.event, s.detail, s.ip, u.name user_name FROM security_events s LEFT JOIN users u ON u.id = s.user_id WHERE s.agency_id = ? ORDER BY s.id DESC LIMIT 200`, [t.agencyId]));
});

// ---- Global search (role-aware, branch-aware, 6 per type) ----
adminRouter.get('/search', async (req, res) => {
  const t = T(req); const raw = String(req.query.q ?? '').trim();
  if (raw.length < 2) return void res.json([]);
  const q = `%${raw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const role = req.ctx!.role, finance = role !== 'agent', branch = req.ctx!.branchId;
  const out: { type: string; id: number; label: string; sub?: string; route: string }[] = [];
  const add = (type: string, route: string, rows: any[]) => rows.forEach((r) => out.push({ type, route, id: r.id, label: r.label, sub: r.sub }));
  add('Client', '/clients', await t.query(`SELECT id, name label, email sub FROM clients WHERE agency_id = ? AND (name LIKE ? OR email LIKE ?) ORDER BY name LIMIT 6`, [t.agencyId, q, q]));
  add('Ticket invoice', '/ticket-invoices', await t.query(
    `SELECT i.id, i.invoice_no label, c.name sub FROM ticket_invoices i JOIN accounts c ON c.id = i.client_account_id AND c.agency_id = i.agency_id
     WHERE i.agency_id = ? AND (i.invoice_no LIKE ? OR c.name LIKE ? OR i.ref_no LIKE ?) ${role === 'agent' ? 'AND i.created_by = ?' : ''} ${branch ? 'AND i.branch_id = ?' : ''} ORDER BY i.id DESC LIMIT 6`,
    [t.agencyId, q, q, q, ...(role === 'agent' ? [req.ctx!.userId] : []), ...(branch ? [branch] : [])]));
  add('Passenger / ticket', '/ticket-search', await t.query(
    `SELECT l.id, COALESCE(l.passenger_name, l.ticket_no) label, l.ticket_no sub FROM ticket_lines l JOIN ticket_invoices i ON i.id = l.invoice_id AND i.agency_id = l.agency_id
     WHERE l.agency_id = ? AND (l.passenger_name LIKE ? OR l.ticket_no LIKE ? OR l.pnr LIKE ?) ${role === 'agent' ? 'AND i.created_by = ?' : ''} ${branch ? 'AND i.branch_id = ?' : ''} LIMIT 6`,
    [t.agencyId, q, q, q, ...(role === 'agent' ? [req.ctx!.userId] : []), ...(branch ? [branch] : [])]));
  add('Booking', '/commissions', await t.query(`SELECT id, reference label, destination sub FROM bookings WHERE agency_id = ? AND (reference LIKE ? OR destination LIKE ?) LIMIT 6`, [t.agencyId, q, q]));
  add('Airline', '/airlines', await t.query(`SELECT id, name label, code sub FROM airlines WHERE agency_id = ? AND (name LIKE ? OR code LIKE ? OR iata_code LIKE ?) LIMIT 6`, [t.agencyId, q, q, q]));
  if (finance) {
    add('Invoice', '/invoices', await t.query(`SELECT i.id, i.number label, c.name sub FROM invoices i JOIN clients c ON c.id = i.client_id AND c.agency_id = i.agency_id WHERE i.agency_id = ? AND (i.number LIKE ? OR c.name LIKE ?) ORDER BY i.id DESC LIMIT 6`, [t.agencyId, q, q]));
    add('Supplier', '/suppliers', await t.query(`SELECT id, name label, email sub FROM suppliers WHERE agency_id = ? AND name LIKE ? LIMIT 6`, [t.agencyId, q]));
    add('Account', '/accounts', await t.query(`SELECT id, name label, code sub FROM accounts WHERE agency_id = ? AND (name LIKE ? OR code LIKE ?) LIMIT 6`, [t.agencyId, q, q]));
  }
  res.json(out);
});
