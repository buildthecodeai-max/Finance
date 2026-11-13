import { Router, raw } from 'express';
import { z } from 'zod';
import { ALL_EDITORS, WRITERS, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { Tenant } from '../db.js';
import { FIELDS, norm } from '../services/extImport/engine.js';
import * as X from '../services/extImport/service.js';
import { idParam, parse, T, toCsv } from './util.js';

/** External Import. Everyone with a login can read; admin / finance manager / agent can upload and review; only admin / finance manager can import, roll back, reconcile and use "update" / "import separately". */
export const extImportRouter = Router();
const EDIT = requireRole(...ALL_EDITORS), WRITE = requireRole(...WRITERS);
const actorOf = (req: any) => ({ userId: req.ctx.userId, ip: req.ip, role: req.ctx.role, ua: req.get('user-agent') ?? null });

extImportRouter.get('/fields', (_req, res) => res.json(FIELDS));

/* ── uploads: one file per request, raw bytes, name in a header (the client sends several files one after another) ── */
extImportRouter.post('/upload', EDIT, raw({ type: '*/*', limit: X.MAX_BYTES }), async (req, res) => {
  const t = T(req); const name = decodeURIComponent(String(req.get('x-file-name') ?? '')).replace(/[\\/]/g, '_').trim();
  if (!name) throw new HttpError(400, 'Missing file name');
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Send the file as the request body');
  const { id, same_file } = await X.createBatch(t, name, req.body);
  setImmediate(() => { X.processBatch(t.agencyId, t.actor, id).catch(() => {}); });     // background: the page polls the batch
  res.status(202).json({ id, same_file });
});

/* ── batches ── */
extImportRouter.get('/batches', async (req, res) => {
  const t = T(req);
  const rows = await t.query(`SELECT b.id, b.file_name, b.file_format, b.file_size, b.status, b.stage, b.progress, b.error, b.payer_name, b.currency, b.total_rows, b.valid_rows, b.error_rows, b.duplicate_rows, b.skipped_rows, b.imported_rows, b.failed_rows, b.unmatched_payments, b.imported_amount, b.uploaded_at, b.committed_at, b.rolled_back_at, b.rollback_reason,
      u.name uploaded_by_name FROM ext_batches b LEFT JOIN users u ON u.id = b.uploaded_by WHERE b.agency_id = ? ORDER BY b.id DESC LIMIT 300`, [t.agencyId]);
  res.json(rows);
});

extImportRouter.get('/batches/:id', async (req, res) => {
  const t = T(req); const b = await X.getBatch(t, idParam(req)); const a = await t.agency();
  const client = b.payer_client_id ? await t.one('SELECT id, name, currency FROM clients WHERE agency_id = ? AND id = ?', [t.agencyId, b.payer_client_id]) : null;
  const events = await t.query(`SELECT e.id, e.action, e.detail, e.created_at, u.name user_name FROM ext_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.agency_id = ? AND e.batch_id = ? ORDER BY e.id DESC LIMIT 100`, [t.agencyId, b.id]);
  const { file_key, ...rest } = b;
  const un = await t.one<any>(`SELECT COUNT(*) n FROM ext_txns WHERE agency_id = ? AND batch_id = ? AND status = 'active' AND kind <> 'payment' AND invoice_id IS NULL AND voucher_id IS NULL`, [t.agencyId, b.id]);
  res.json({ ...rest, unposted: Number(un?.n ?? 0), client, suggest_currency: a?.base_currency ?? null, events });
});

extImportRouter.get('/batches/:id/rows', async (req, res) => {
  const t = T(req); const id = idParam(req);
  const status = String(req.query.status ?? ''), sheet = String(req.query.sheet ?? ''), q = String(req.query.q ?? '').trim();
  const page = Math.max(1, Number(req.query.page) || 1), size = Math.min(200, Math.max(10, Number(req.query.size) || 50));
  const w = ['agency_id = ?', 'batch_id = ?'], p: any[] = [t.agencyId, id];
  if (status === 'issues') w.push(`status IN ('error','warning','duplicate','failed')`);
  else if (status === 'payments') w.push(`JSON_UNQUOTE(JSON_EXTRACT(data, '$.kind')) = 'payment'`);
  else if (['ok', 'warning', 'error', 'duplicate', 'skipped', 'imported', 'failed'].includes(status)) { w.push('status = ?'); p.push(status); }
  else w.push(`status <> 'skipped'`);
  if (sheet) { w.push('sheet = ?'); p.push(sheet); }
  if (q) { w.push(`(JSON_UNQUOTE(JSON_EXTRACT(data, '$.passenger_name')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.pnr')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.invoice_no')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.ticket_no')) LIKE ?)`); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const [{ n }] = await t.query<any>(`SELECT COUNT(*) n FROM ext_rows WHERE ${w.join(' AND ')}`, p);
  const rows = await t.query(`SELECT id, sheet, src_row, section, data, status, problems, dup_kind, dup_txn_id, action, action_reason, match_json, edited, raw FROM ext_rows WHERE ${w.join(' AND ')} ORDER BY id LIMIT ? OFFSET ?`, [...p, size, (page - 1) * size]);
  res.json({ total: Number(n), page, size, rows });
});

const Settings = z.object({
  payer_client_id: z.number().int().nullable().optional(), payer_name: z.string().trim().max(200).nullable().optional(),
  currency: z.string().length(3).transform((s) => s.toUpperCase()).nullable().optional(),
  include: z.record(z.boolean()).optional(),
});
extImportRouter.put('/batches/:id/settings', EDIT, async (req, res) => {
  const t = T(req); const id = idParam(req); const b = parse(Settings, req.body); const cur = await X.getBatch(t, id);
  if (cur.status !== 'review') throw new HttpError(409, 'This import can no longer be changed');
  const set: Record<string, any> = {};
  if (b.payer_client_id !== undefined) { await t.ref('clients', b.payer_client_id, 'client'); set.payer_client_id = b.payer_client_id; if (b.payer_client_id) set.payer_name = (await t.get<any>('clients', b.payer_client_id)).name; }
  if (b.payer_name !== undefined && b.payer_client_id === undefined) { set.payer_name = b.payer_name || null; set.payer_client_id = null; }
  if (b.currency !== undefined) set.currency = b.currency;
  if (b.include) { const sheets = (cur.sheets as any[]).map((s) => (s.name in b.include! && s.kind === 'table' ? { ...s, include: b.include![s.name] } : s)); set.sheets = JSON.stringify(sheets); }
  if (Object.keys(set).length) {
    const cols = Object.keys(set); const { pool } = await import('../db.js');
    await pool.query(`UPDATE ext_batches SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE agency_id = ? AND id = ?`, [...Object.values(set), t.agencyId, id]);
    await X.ev(t, id, 'settings_changed', `Changed: ${cols.filter((c) => c !== 'sheets').join(', ')}${b.include ? ' sheets included' : ''}`);
    await X.rebuild(t, id);
  }
  res.json({ ok: true });
});

extImportRouter.put('/batches/:id/mapping', EDIT, async (req, res) => {
  const b = parse(z.object({ sig: z.string(), map: z.record(z.number().int().nullable()) }), req.body);
  await X.setMapping(T(req), idParam(req), b.sig, b.map); res.json({ ok: true });
});

extImportRouter.patch('/batches/:id/rows/:rid', EDIT, async (req, res) => {
  const b = parse(z.object({ data: z.record(z.any()), reason: z.string().trim().min(3).max(200) }), req.body);
  await X.editRow(T(req), idParam(req), Number(req.params.rid), b.data, b.reason); res.json({ ok: true });
});

const Action = z.object({ action: z.enum(['import', 'skip', 'update', 'separate']), reason: z.string().trim().max(200).optional() });
async function setAction(t: Tenant, req: any, batchId: number, rowIds: number[] | 'duplicates', b: z.infer<typeof Action>) {
  const batch = await X.getBatch(t, batchId); if (batch.status !== 'review') throw new HttpError(409, 'This import can no longer be changed');
  if ((b.action === 'update' || b.action === 'separate') && !WRITERS.includes(req.ctx.role)) throw new HttpError(403, 'Only an admin or finance manager can authorise updating an existing record or importing a duplicate separately');
  if ((b.action === 'update' || b.action === 'separate') && (b.reason ?? '').length < 3) throw new HttpError(400, 'Give a reason for this authorisation');
  const where = rowIds === 'duplicates' ? `status = 'duplicate'` : `id IN (?)`;
  const rows = await t.query<any>(`SELECT id, dup_kind, status FROM ext_rows WHERE agency_id = ? AND batch_id = ? AND ${where}`, rowIds === 'duplicates' ? [t.agencyId, batchId] : [t.agencyId, batchId, rowIds]);
  const ok = rows.filter((r) => r.status === 'duplicate' && !(b.action === 'update' && r.dup_kind === 'in_file') && (b.action !== 'import'));
  if (b.action === 'import') throw new HttpError(400, 'Choose skip, update or import separately for a duplicate');
  if (!ok.length) throw new HttpError(409, b.action === 'update' ? 'Only lines that match a record already imported can update it' : 'No duplicate lines to change');
  const { pool } = await import('../db.js');
  await pool.query('UPDATE ext_rows SET action = ?, action_reason = ? WHERE agency_id = ? AND batch_id = ? AND id IN (?)', [b.action, b.reason ?? 'chosen by user', t.agencyId, batchId, ok.map((r) => r.id)]);
  await X.ev(t, batchId, 'duplicate_decision', `${ok.length} duplicate line(s): ${b.action}${b.reason ? ` — ${b.reason}` : ''}`);
  await X.rebuild(t, batchId);
  return ok.length;
}
extImportRouter.post('/batches/:id/rows/:rid/action', EDIT, async (req, res) => { const t = T(req); res.json({ changed: await setAction(t, req, idParam(req), [Number(req.params.rid)], parse(Action, req.body)) }); });
extImportRouter.post('/batches/:id/duplicates', EDIT, async (req, res) => { const t = T(req); res.json({ changed: await setAction(t, req, idParam(req), 'duplicates', parse(Action, req.body)) }); });

extImportRouter.post('/batches/:id/commit', WRITE, async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().max(200).optional() }), req.body ?? {});
  res.json(await X.commitBatch(T(req), idParam(req), b));
});
extImportRouter.post('/batches/:id/post', WRITE, async (req, res) => { res.json(await X.postPending(T(req), idParam(req))); });
extImportRouter.post('/batches/:id/cancel', EDIT, async (req, res) => { await X.cancelBatch(T(req), idParam(req)); res.json({ ok: true }); });
extImportRouter.post('/batches/:id/rollback', WRITE, async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
  res.json(await X.rollbackBatch(T(req), idParam(req), b.reason));
});
extImportRouter.get('/batches/:id/errors.csv', async (req, res) => {
  const { b, rows } = await X.errorReport(T(req), idParam(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="import-${b.id}-problems.csv"`);
  res.send(toCsv(['Sheet', 'Row', 'Status', 'Problems', 'Source line'], rows.map((r) => [r.sheet, r.row, r.status, r.problems, r.source])));
});

/* ── mapping templates ── */
extImportRouter.get('/templates', async (req, res) => {
  const t = T(req); res.json((await t.query<any>(`SELECT m.id, m.name, m.mapping, m.payer_hint, m.created_at, u.name created_by_name FROM ext_mapping_templates m LEFT JOIN users u ON u.id = m.created_by WHERE m.agency_id = ? ORDER BY m.name`, [t.agencyId])).map((r) => ({ ...r, mapping: typeof r.mapping === 'string' ? JSON.parse(r.mapping) : r.mapping })));
});
extImportRouter.post('/templates', EDIT, async (req, res) => {
  const t = T(req); const b = parse(z.object({ name: z.string().trim().min(2).max(100), batch_id: z.number().int(), sig: z.string().optional() }), req.body);
  const batch = await X.getBatch(t, b.batch_id); const sheet = (batch.sheets as any[]).find((s) => s.kind === 'table' && (!b.sig || s.sig === b.sig));
  if (!sheet) throw new HttpError(404, 'No layout to save');
  const labels: Record<string, string> = {};
  for (const [f, c] of Object.entries(sheet.map as Record<string, number>)) { const l = norm(sheet.headers[c]); if (l) labels[l] = f; }
  if (await t.one('SELECT id FROM ext_mapping_templates WHERE agency_id = ? AND name = ?', [t.agencyId, b.name])) throw new HttpError(409, 'A template with this name already exists');
  const id = await t.insert('ext_mapping_templates', { name: b.name, mapping: JSON.stringify({ labels, headers: sheet.headers }), payer_hint: batch.payer_name, created_by: t.actor.userId });
  res.status(201).json({ id });
});
extImportRouter.delete('/templates/:id', WRITE, async (req, res) => { await T(req).remove('ext_mapping_templates', idParam(req)); res.json({ ok: true }); });

/* ── reports ── */
const Q = z.object({
  from: z.string().optional(), to: z.string().optional(), client_id: z.coerce.number().int().optional(), passenger: z.string().max(100).optional(), location: z.string().max(100).optional(),
  status: z.enum(['paid', 'partial', 'unpaid', 'credit', 'payment']).optional(), kind: z.enum(['sale', 'credit_note', 'refund', 'exchange', 'payment', 'reversal']).optional(), q: z.string().max(100).optional(),
});
const filters = (req: any) => parse(Q, req.query) as X.Filters;

extImportRouter.get('/summary', async (req, res) => {
  const t = T(req); const { lines } = await X.ledger(t, {});
  const bill = lines.filter((l) => l.kind !== 'payment'), pay = lines.filter((l) => l.kind === 'payment');
  const sum = (a: any[], k: string) => Math.round(a.reduce((s, l) => s + l[k], 0) * 100) / 100;
  res.json({ records: lines.length, billed: sum(bill, 'net'), received: sum(bill, 'received'), outstanding: sum(bill, 'outstanding'), payments: sum(pay, 'net'), first: lines[0]?.txn_date ?? null, last: lines[lines.length - 1]?.txn_date ?? null, currencies: [...new Set(lines.map((l) => l.currency))] });
});
extImportRouter.get('/report/period', async (req, res) => { const v = String(req.query.view ?? 'monthly'); if (!['daily', 'weekly', 'monthly', 'yearly', 'range'].includes(v)) throw new HttpError(400, 'Bad view'); res.json(await X.byPeriod(T(req), v, filters(req))); });
extImportRouter.get('/report/transactions', async (req, res) => {
  const { lines } = await X.ledger(T(req), filters(req)); const page = Math.max(1, Number(req.query.page) || 1), size = Math.min(200, Number(req.query.size) || 50);
  res.json({ total: lines.length, page, size, rows: lines.slice((page - 1) * size, page * size) });
});
extImportRouter.get('/report/passengers', async (req, res) => res.json(await X.passengers(T(req), filters(req))));
extImportRouter.get('/report/passengers/detail', async (req, res) => res.json(await X.passengerDetail(T(req), String(req.query.key ?? ''))));
extImportRouter.get('/report/locations', async (req, res) => { const by = String(req.query.by ?? 'route'); if (!['route', 'origin', 'destination'].includes(by)) throw new HttpError(400, 'Bad grouping'); res.json(await X.locations(T(req), filters(req), by as any)); });
extImportRouter.get('/report/payers', async (req, res) => res.json(await X.payers(T(req), filters(req))));
extImportRouter.get('/report/export.csv', async (req, res) => {
  const { lines } = await X.ledger(T(req), filters(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="external-import-transactions.csv"');
  res.send(toCsv(['Date', 'Type', 'Invoice', 'Passenger', 'PNR', 'Ticket', 'Route', 'Airline', 'Travel date', 'Payer', 'Currency', 'Gross', 'Service', 'Net', 'Received', 'Outstanding', 'State', 'Source file', 'Sheet', 'Row'],
    lines.map((l) => [l.txn_date, l.kind, l.invoice_no, l.passenger_name, l.pnr, l.ticket_no, l.sector, l.airline, l.travel_date, l.payer_name, l.currency, l.gross, l.service_charge, l.net, l.received, l.outstanding, l.pay_state, l.source_file, l.source_sheet, l.source_row])));
});

/* ── reconciliation ── */
extImportRouter.get('/reconciliation', async (req, res) => res.json(await X.reconciliation(T(req))));
extImportRouter.post('/allocations/:id/confirm', WRITE, async (req, res) => { await X.decideAllocation(T(req), idParam(req), 'confirm'); res.json({ ok: true }); });
extImportRouter.post('/allocations/:id/reject', WRITE, async (req, res) => { await X.decideAllocation(T(req), idParam(req), 'reject'); res.json({ ok: true }); });
extImportRouter.post('/payments/:id/allocate', WRITE, async (req, res) => {
  const b = parse(z.object({ invoice_no: z.string().trim().min(1), amount: z.number().positive() }), req.body);
  res.status(201).json({ id: await X.manualAllocate(T(req), idParam(req), b.invoice_no, b.amount) });
});
